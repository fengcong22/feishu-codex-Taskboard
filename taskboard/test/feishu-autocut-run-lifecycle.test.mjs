import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { listenOnFetchSafePort, listenTaskboardOnFetchSafePort } from "../../test/fetch-safe-listen.mjs";
import { createTaskboardServer } from "../server/index.mjs";
import { TaskboardDatabase } from "../server/database.mjs";
import { subjectProjectId } from "../server/feishu-workflow-store.mjs";
import { createStoredZip } from "./stored-zip-fixture.mjs";

const SECRET = "lifecycle-fixture-secret";
const SUBJECT_KEY = "bas_lifecycle:tbl_math";

async function jsonRequest(baseUrl, pathname, body, { method = "POST", headers = {} } = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: {
      "content-type": "application/json",
      "x-taskboard-client": "feishu-bridge",
      "x-feishu-bridge-secret": SECRET,
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { response, body: text ? JSON.parse(text) : null };
}

async function waitForRun(app, taskId, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = app.database.listFeishuAutoCutRuns(taskId)[0];
    if (run) return run;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for Auto-Cut run for '${taskId}'`);
}

async function waitForRuns(app, taskId, count, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const runs = app.database.listFeishuAutoCutRuns(taskId);
    if (runs.length >= count) return runs;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${count} Auto-Cut runs for '${taskId}'`);
}

async function waitForJsonFile(filename, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { return JSON.parse(await readFile(filename, "utf8")); } catch {}
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for '${filename}'`);
}

async function waitForTaskStatus(app, taskId, status, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const task = app.database.getTask(taskId);
    if (task?.status === status) return task;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for task '${taskId}' to reach '${status}'`);
}

async function createBridge(controlledContext, status = 200) {
  const requests = [];
  let currentContext = controlledContext;
  let currentStatus = status;
  let responseGate = null;
  const bridge = createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/api/feishu/workflow/controlled-context") {
      response.writeHead(404).end();
      return;
    }
    let body = "";
    for await (const chunk of request) body += chunk;
    requests.push(JSON.parse(body));
    await responseGate;
    response.writeHead(currentStatus, { "content-type": "application/json" });
    response.end(JSON.stringify(
      currentStatus >= 200 && currentStatus < 300
        ? { controlledContext: currentContext }
        : { error: { code: currentContext } },
    ));
  });
  const address = await listenOnFetchSafePort(bridge);
  return {
    requests,
    url: `http://127.0.0.1:${address.port}`,
    holdResponses(gate) { responseGate = gate; },
    setResponse(nextContext, nextStatus = 200) {
      currentContext = nextContext;
      currentStatus = nextStatus;
    },
    async close() { await new Promise((resolve) => bridge.close(resolve)); },
  };
}

async function createFixture({
  controlledContext,
  bridgeStatus = 200,
  turnDelayMs = 0,
  allowAutomaticExecution = false,
  autoCutRunner = undefined,
  localAutoCutArtifactReportTimeoutMs = undefined,
  processEnvironmentOverrides = {},
  packageZipSourceDirectory = undefined,
  packageZipOutputMode = undefined,
  coursePathResolver = undefined,
} = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-autocut-lifecycle-"));
  const workspacePath = path.join(directory, "workspace");
  const zipSourceDirectory = path.join(directory, "zip-source");
  await mkdir(workspacePath);
  await mkdir(zipSourceDirectory);
  const capturePath = path.join(directory, "codex-env.json");
  const promptCapturePath = path.join(directory, "codex-prompt.txt");
  const codexExecutable = path.join(directory, "fake-codex.mjs");
  await writeFile(codexExecutable, `
import { writeFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "debug") {
  process.stdout.write(${JSON.stringify(JSON.stringify({
    models: [{ slug: "fixture", default_reasoning_level: "low", supported_reasoning_levels: [{ effort: "low" }] }],
  }))});
} else if (args[0] === "app-server") {
  process.stdin.setEncoding("utf8");
  let buffer = "";
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\\n")) >= 0) {
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      if (message.id === 1) process.stdout.write('{"id":1,"result":{}}\\n');
      if (message.id === 2) process.stdout.write('{"id":2,"result":{"data":[]}}\\n');
    }
  });
} else {
  let prompt = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { prompt += chunk; });
  process.stdin.on("end", () => {
    const keys = [
      "CODEX_AUTOCUT_ARTIFACT_REPORT_URL", "CODEX_AUTOCUT_ARTIFACT_REPORT_TOKEN",
      "CODEX_AUTOCUT_SOURCE_MANIFEST_PATH", "CODEX_AUTOCUT_SOURCE_MANIFEST_SHA256",
      "CODEX_AUTOCUT_EXECUTION_INPUT_PATH", "CODEX_AUTOCUT_JOB_ROOT", "CODEX_AUTOCUT_DRAFTS_ROOT",
      "CODEX_AUTOCUT_RESULT_PATH", "CODEX_AUTOCUT_PACKAGE_ZIP_PATH", "CODEX_AUTOCUT_TASK_ID",
      "CODEX_AUTOCUT_RUN_ID", "CODEX_AUTOCUT_SUBJECT_KEY", "CODEX_AUTOCUT_CONFIG_VERSION",
      "CODEX_AUTOCUT_STAGE_ID", "CODEX_AUTOCUT_EVENT_ID", "CODEX_FEISHU_BRIDGE_SECRET",
    ];
    writeFileSync(${JSON.stringify(promptCapturePath)}, prompt);
    writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify(Object.fromEntries(
      keys.filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]]),
    )));
    setTimeout(() => {
      process.stdout.write('{"type":"thread.started","thread_id":"fixture-session"}\\n');
      process.stdout.write('{"type":"turn.completed"}\\n');
    }, ${JSON.stringify(turnDelayMs)});
  });
}
`);
  await chmod(codexExecutable, 0o755);
  const bridge = await createBridge(controlledContext, bridgeStatus);
  const serverOptions = {
    dataDirectory: directory,
    codexExecutable,
    feishuBridgeUrl: bridge.url,
    feishuBridgeSecret: SECRET,
    processEnv: { ...process.env, ...processEnvironmentOverrides, CODEX_FEISHU_BRIDGE_SECRET: SECRET },
    feishuPackages: {
      packages: {
        "Auto-cut-lite": {
          alias: "Auto-cut-lite",
          name: "Auto-Cut Lite",
          projectId: "autocut-lite",
          workspacePath,
          zipSourceDirectory: packageZipSourceDirectory === undefined ? zipSourceDirectory : packageZipSourceDirectory,
          ...(packageZipOutputMode ? { zipOutputMode: packageZipOutputMode } : {}),
          prompt: "trusted package prompt",
          state: "enabled",
          revision: 1,
          maxConcurrent: 1,
        },
      },
    },
    feishuWorkflowSync: async () => ({ ok: true }),
    allowAutomaticExecution,
    autoCutRunner,
    localAutoCutArtifactReportTimeoutMs,
    ...(coursePathResolver ? { coursePathResolver } : {}),
  };
  const app = createTaskboardServer(serverOptions);
  const address = await listenTaskboardOnFetchSafePort(app);
  return {
    app,
    bridge,
    baseUrl: `http://127.0.0.1:${address.port}`,
    capturePath,
    promptCapturePath,
    directory,
    workspacePath,
    zipSourceDirectory,
    serverOptions,
  };
}

async function registerSubject(fixture, {
  executionMode = "manual",
  enqueueMode = "manual",
  targetPath = path.join(fixture.directory, "upload"),
  targetId = "target",
  delivery = undefined,
  reviewStages = false,
} = {}) {
  const catalog = await jsonRequest(fixture.baseUrl, "/api/local/feishu/workflow/catalog", {
    baseToken: "bas_lifecycle",
    baseName: "Lifecycle Base",
    tables: [{
      tableId: "tbl_math",
      tableName: "数学",
      fields: [
        {
          fieldId: "fld_status",
          fieldName: "流程",
          type: 3,
          uiType: "SingleSelect",
          options: [
            { id: "opt_other", name: "其他" },
            { id: "opt_initial", name: "初稿" },
            { id: "opt_processing", name: "自动剪辑中" },
          ],
        },
        { fieldId: "fld_document", fieldName: "素材文档", type: 1, uiType: "Text" },
        { fieldId: "fld_name", fieldName: "命名", type: 1, uiType: "Text" },
        ...(reviewStages ? [{
          fieldId: "fld_review",
          fieldName: "Review",
          type: 3,
          uiType: "SingleSelect",
          options: [
            { id: "opt_review_other", name: "Other" },
            { id: "opt_first_review", name: "First review" },
            { id: "opt_final_review", name: "Final review" },
          ],
        }] : []),
      ],
    }],
  });
  assert.equal(catalog.response.status, 201, JSON.stringify(catalog.body));
  const subject = catalog.body.catalog[0].subjects[0];
  const route = `/api/local/feishu/workflow/subjects/${encodeURIComponent(SUBJECT_KEY)}`;
  const stage = {
    enabled: true,
    trigger: { fieldId: "fld_status", fieldName: "流程", optionId: "opt_initial", value: "初稿" },
    videoSource: { kind: "docx_section", anchorText: "录屏" },
    reviewSource: { kind: "docx_section", anchorText: "修改意见" },
    audio: { mode: "video_original" },
    artifactTargetPath: path.join(fixture.directory, "stage-output"),
    nameSuffix: "_初稿",
  };
  const patch = await jsonRequest(fixture.baseUrl, route, {
    statusField: { fieldId: "fld_status", fieldName: "流程" },
    ...(reviewStages ? { reviewStatusField: { fieldId: "fld_review", fieldName: "Review" } } : {}),
    documentField: { fieldId: "fld_document", fieldName: "素材文档" },
    namingField: { fieldId: "fld_name", fieldName: "命名" },
    stages: {
      initial: stage,
      ...Object.fromEntries(["first_review", "final_review"].map((stageId) => [stageId, {
        ...stage,
        enabled: reviewStages,
        ...(reviewStages ? {
          trigger: {
            fieldId: "fld_review", fieldName: "Review", optionId: `opt_${stageId}`,
            value: stageId === "first_review" ? "First review" : "Final review",
          },
          nameSuffix: `_${stageId}`,
        } : {}),
      }])),
    },
    trigger: { fieldId: "fld_status", fieldName: "流程", startValue: "初稿", optionId: "opt_initial" },
    title: { fieldId: null, fieldName: null },
    execution: { mode: executionMode, concurrencyGroup: "autocut", maxConcurrent: 1, resourceGroups: [] },
    packageRoute: { routeMode: "fixed", packageAlias: "Auto-cut-lite", subjectCodeFieldId: null, branchMap: null },
    upload: {
      enqueueMode,
      artifactSourceMode: "driver_report",
      artifactSourcePath: fixture.zipSourceDirectory,
      targetId,
      targetPath,
      uploadConcurrency: 1,
    },
    ...(delivery === undefined ? {} : { delivery }),
  }, { method: "PATCH" });
  assert.equal(patch.response.status, 200, JSON.stringify(patch.body));
  const enabled = await jsonRequest(fixture.baseUrl, `${route}/enable`, {
    expectedVersion: patch.body.subject.configVersion,
  });
  assert.equal(enabled.response.status, 200, JSON.stringify(enabled.body));
  return enabled.body.subject;
}

function registration(subject, controlledContext, { stageId = "initial", eventId = "evt-lifecycle-1" } = {}) {
  return {
    event: {
      eventId,
      baseToken: "bas_lifecycle",
      tableId: "tbl_math",
      recordId: "rec_1",
      statusFieldId: subject.stages[stageId].trigger.fieldId,
      beforeOptionId: stageId === "initial" ? "opt_other" : "opt_review_other",
      afterOptionId: subject.stages[stageId].trigger.optionId,
    },
    binding: { subjectKey: SUBJECT_KEY, configVersion: subject.configVersion, stageId },
    controlledContext,
  };
}

function feishuDescription(origin) {
  const encoded = Buffer.from(JSON.stringify(origin), "utf8").toString("base64url");
  return `<!-- feishu-codex-task:v1:${encoded} -->`;
}

function runBinding(run) {
  return {
    task_id: run.taskId,
    run_id: run.runId,
    subject_key: run.subjectKey,
    config_version: run.configVersion,
    stage_id: run.stageId,
    event_id: run.eventId,
  };
}

async function writePassingRunResult(run, {
  includePackageReceipt = true,
  draftRoot = run.artifactName,
  resultOverrides = {},
  receiptOverrides = {},
} = {}) {
  const zip = createStoredZip([
    { name: `${draftRoot}/draft_content.json`, content: "{}" },
    { name: `${draftRoot}/draft_meta_info.json`, content: "{}" },
  ]);
  await writeFile(run.packageZipPath, zip);
  const archiveSha256 = createHash("sha256").update(zip).digest("hex");
  await writeFile(run.resultPath, `${JSON.stringify({
    schema_version: 1,
    binding: runBinding(run),
    manifest_sha256: run.manifestSha256,
    status: "pass",
    package_zip: run.packageZipPath,
    archive_sha256: archiveSha256,
    draft_name: run.artifactName,
    ...resultOverrides,
  })}\n`);
  if (includePackageReceipt) {
    await writeFile(`${run.packageZipPath}.receipt.json`, `${JSON.stringify({
      schema_version: 2,
      status: "pass",
      workflow_mode: "lite",
      delivery_mode: "lite_zip",
      archive_path: run.packageZipPath,
      archive_sha256: archiveSha256,
      package_root_name: run.artifactName,
      draft_name: run.artifactName,
      zip_crc_pass: true,
      zip_tree_identity_pass: true,
      source_manifest_sha256: run.manifestSha256,
      binding: runBinding(run),
      source_pairs: [],
      package_zip: run.packageZipPath,
      ...receiptOverrides,
    })}\n`);
  }
  return archiveSha256;
}

async function reportRunArtifact(fixture, run, overrides = {}) {
  const claim = fixture.app.database.getTaskAiStartForArtifactReport(run.taskId, run.runId);
  assert.ok(claim);
  return jsonRequest(
    fixture.baseUrl,
    `/api/local/tasks/${encodeURIComponent(run.taskId)}/runs/${encodeURIComponent(run.runId)}/artifact-report`,
    {
      path: overrides.path ?? run.packageZipPath,
      sha256: overrides.sha256,
      manifestSha256: overrides.manifestSha256 ?? run.manifestSha256,
    },
    {
      headers: {
        authorization: `Bearer ${claim.claimToken}`,
        "x-taskboard-client": "taskctl",
      },
    },
  );
}

for (const stageId of ["initial", "first_review", "final_review"]) {
  test(`a composite event ID stays exact through ${stageId} run inputs and artifact verification`, async () => {
    const controlledContext = {
      documentLinks: ["https://guanghe.feishu.cn/docx/composite-event-fixture"],
      namingDisplayValue: "Composite event course",
      namingValueUnique: true,
    };
    const fixture = await createFixture({ controlledContext, turnDelayMs: 5_000 });
    const eventId = `evt-provider:${stageId === "initial" ? "fld_status" : "fld_review"}`;
    try {
      const subject = await registerSubject(fixture, { reviewStages: true });
      const created = await jsonRequest(fixture.baseUrl, "/api/local/feishu/tasks",
        registration(subject, controlledContext, { stageId, eventId }));
      assert.equal(created.response.status, 201, JSON.stringify(created.body));
      const started = await jsonRequest(fixture.baseUrl, `/api/tasks/${created.body.task.id}/start-ai`, {});
      assert.equal(started.response.status, 202, JSON.stringify(started.body));
      const run = await waitForRun(fixture.app, created.body.task.id);
      assert.equal(run.eventId, eventId);
      assert.equal(run.stageId, stageId);
      const manifest = JSON.parse(await readFile(run.manifestPath, "utf8"));
      assert.deepEqual(manifest.binding, runBinding(run));
      const env = await waitForJsonFile(fixture.capturePath);
      assert.equal(env.CODEX_AUTOCUT_EVENT_ID, eventId);
      assert.equal(env.CODEX_AUTOCUT_STAGE_ID, stageId);

      const mutatedBinding = { ...runBinding(run), event_id: eventId.replace(":", "_") };
      for (const source of ["resultOverrides", "receiptOverrides"]) {
        const sha256 = await writePassingRunResult(run, { [source]: { binding: mutatedBinding } });
        const rejected = await reportRunArtifact(fixture, run, { sha256 });
        assert.equal(rejected.response.status, 409, `${source}: ${JSON.stringify(rejected.body)}`);
        assert.equal(rejected.body.error.code, "AUTOCUT_RUN_BINDING_MISMATCH", source);
        assert.deepEqual(fixture.app.database.listTaskArtifacts(run.taskId), [], source);
      }

      const sha256 = await writePassingRunResult(run);
      const accepted = await reportRunArtifact(fixture, run, { sha256 });
      assert.equal(accepted.response.status, 201, JSON.stringify(accepted.body));
      assert.equal(fixture.app.database.getTaskArtifactForRun(run.taskId, run.runId).validationStatus, "verified");
      for (const filename of [run.resultPath, `${run.packageZipPath}.receipt.json`]) {
        assert.equal(JSON.parse(await readFile(filename, "utf8")).binding.event_id, eventId);
      }
    } finally {
      await fixture.app.close();
      await fixture.bridge.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });
}

test("a blocked task retry preserves its composite event ID through a verified local run", async () => {
  const eventId = "evt-provider:fld_review";
  const controlledContext = {
    documentLinks: ["https://guanghe.feishu.cn/docx/composite-event-retry"],
    namingDisplayValue: "Composite event retry",
    namingValueUnique: true,
  };
  const invocations = [];
  const fixture = await createFixture({
    controlledContext: "document_link_missing",
    bridgeStatus: 409,
    autoCutRunner: async ({ run }) => {
      invocations.push(run);
      await writePassingRunResult(run);
      return { exitCode: 0 };
    },
  });
  try {
    const subject = await registerSubject(fixture, { reviewStages: true });
    const created = await jsonRequest(fixture.baseUrl, "/api/local/feishu/tasks",
      registration(subject, controlledContext, { stageId: "first_review", eventId }));
    assert.equal(created.response.status, 201, JSON.stringify(created.body));
    const initial = await jsonRequest(fixture.baseUrl, `/api/tasks/${created.body.task.id}/start-ai`, {});
    assert.equal(initial.response.status, 409, JSON.stringify(initial.body));
    const blocked = fixture.app.database.getTask(created.body.task.id);
    const [firstRun] = fixture.app.database.listFeishuAutoCutRuns(blocked.id);
    assert.equal(blocked.status, "blocked");
    assert.equal(firstRun.eventId, eventId);
    fixture.bridge.setResponse(controlledContext);
    const retried = await jsonRequest(fixture.baseUrl, `/api/local/tasks/${blocked.id}/autocut-retry`, {
      version: blocked.version,
      runConsent: { allowVideoAudioAsr: true, allowConfiguredLocalOutput: true },
    });
    assert.equal(retried.response.status, 202, JSON.stringify(retried.body));
    await waitForTaskStatus(fixture.app, blocked.id, "in_review");
    const runs = fixture.app.database.listFeishuAutoCutRuns(blocked.id);
    assert.deepEqual(runs.map((run) => run.eventId), [eventId, eventId]);
    assert.deepEqual(runs.map((run) => run.attempt), [1, 2]);
    assert.equal(runs[0].runId, firstRun.runId);
    assert.equal(runs[0].state, "blocked");
    assert.notEqual(runs[1].runId, firstRun.runId);
    assert.deepEqual(invocations.map((run) => run.eventId), [eventId]);
    assert.equal(JSON.parse(await readFile(runs[1].manifestPath, "utf8")).binding.event_id, eventId);
    assert.equal(fixture.app.database.getTaskArtifactForRun(blocked.id, runs[1].runId).validationStatus, "verified");
  } finally {
    await fixture.app.close();
    await fixture.bridge.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("an initial automatic phased run completes locally without Codex or taskctl on PATH", async () => {
  const controlledContext = {
    documentLinks: ["https://guanghe.feishu.cn/docx/automatic-local-runner"],
    namingDisplayValue: "自动本机执行",
    namingValueUnique: true,
  };
  const invocations = [];
  const fixture = await createFixture({
    controlledContext,
    allowAutomaticExecution: true,
    processEnvironmentOverrides: { PATH: "", Path: "" },
    autoCutRunner: async ({ run }) => {
      invocations.push(run.runId);
      await writePassingRunResult(run);
      return { exitCode: 0 };
    },
  });
  try {
    const subject = await registerSubject(fixture, { executionMode: "automatic" });
    const created = await jsonRequest(fixture.baseUrl, "/api/local/feishu/tasks", registration(subject, controlledContext));
    assert.equal(created.response.status, 201, JSON.stringify(created.body));
    const task = await waitForTaskStatus(fixture.app, created.body.task.id, "done", 8_000);
    const [run] = fixture.app.database.listFeishuAutoCutRuns(task.id);
    assert.deepEqual(invocations, [run.runId]);
    assert.equal(run.state, "completed");
    assert.equal(fixture.app.database.getAiChatThread(task.threadId).model, "local-autocut");
    const artifact = fixture.app.database.getTaskArtifactForRun(task.id, run.runId);
    assert.equal(artifact.validationStatus, "verified");
    assert.equal(artifact.filename, path.basename(run.packageZipPath));
    assert.equal(fixture.app.database.getTaskAiStartForArtifactReport(task.id, run.runId), null);
    await assert.rejects(readFile(fixture.promptCapturePath, "utf8"), { code: "ENOENT" });
  } finally {
    await fixture.app.close();
    await fixture.bridge.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("the panel-authorized retry of a failed automatic run keeps local execution and separate progress history", async () => {
  const controlledContext = {
    documentLinks: ["https://guanghe.feishu.cn/docx/automatic-local-retry"],
    namingDisplayValue: "自动执行后重试",
    namingValueUnique: true,
  };
  const invocations = [];
  const runConsent = { allowVideoAudioAsr: true, allowConfiguredLocalOutput: true };
  const fixture = await createFixture({
    controlledContext,
    allowAutomaticExecution: true,
    autoCutRunner: async ({ run, onProgress, autoCutRunConsent }) => {
      invocations.push({ runId: run.runId, autoCutRunConsent });
      onProgress({ phase: "preflight", status: "complete" });
      onProgress({ phase: "document_fetch", status: "running" });
      if (invocations.length === 1) {
        onProgress({ phase: "document_fetch", status: "failed" });
        onProgress({ phase: "asset_download", status: "skipped" });
        onProgress({ phase: "package_publish", status: "skipped" });
        onProgress({ phase: "package_publish", status: "failed" });
        const failure = new Error("The fixture document could not be read");
        failure.code = "fixture_document_fetch_failed";
        throw failure;
      }
      onProgress({ phase: "document_fetch", status: "complete" });
      await writePassingRunResult(run);
      return { exitCode: 0 };
    },
  });
  try {
    const subject = await registerSubject(fixture, { executionMode: "automatic" });
    const created = await jsonRequest(fixture.baseUrl, "/api/local/feishu/tasks", registration(subject, controlledContext));
    assert.equal(created.response.status, 201, JSON.stringify(created.body));
    const blocked = await waitForTaskStatus(fixture.app, created.body.task.id, "blocked", 30_000);
    const [firstRun] = fixture.app.database.listFeishuAutoCutRuns(blocked.id);
    const firstAiRun = fixture.app.database.getAiChatRun(firstRun.runId);
    const firstSnapshot = fixture.app.aiChat.getThreadSnapshot(firstAiRun.threadId);
    assert.equal(firstRun.errorCode, "fixture_document_fetch_failed");
    assert.equal(firstSnapshot.thread.model, "local-autocut");
    assert.ok(firstSnapshot.events.some((event) => event.type === "autocut_progress"
      && event.data.phase === "document_fetch" && event.data.status === "failed"));
    const firstAttempts = await jsonRequest(fixture.baseUrl, `/api/local/tasks/${blocked.id}/autocut-runs`,
      undefined, { method: "GET" });
    assert.equal(firstAttempts.response.status, 200);
    assert.equal(firstAttempts.body.runs[0].threadId, firstAiRun.threadId);
    assert.equal(firstAttempts.body.runs[0].executionKind, "local");
    assert.equal(firstAttempts.body.runs[0].failedPhase, "document_fetch");
    assert.equal(firstAttempts.body.runs[0].lastPhase, "package_publish");

    const retried = await jsonRequest(fixture.baseUrl, `/api/local/tasks/${blocked.id}/autocut-retry`, {
      version: blocked.version,
      runConsent,
    });
    assert.equal(retried.response.status, 202, JSON.stringify(retried.body));
    assert.equal(retried.body.execution.trigger, "retry");
    const completed = await waitForTaskStatus(fixture.app, blocked.id, "done");
    const runs = fixture.app.database.listFeishuAutoCutRuns(blocked.id);
    assert.deepEqual(runs.map((run) => run.attempt), [1, 2]);
    assert.deepEqual(runs.map((run) => run.state), ["blocked", "completed"]);
    assert.deepEqual(runs[0], firstRun, "retry must preserve the failed attempt");
    assert.notEqual(runs[1].runId, firstRun.runId);
    assert.notEqual(runs[1].manifestPath, firstRun.manifestPath);
    assert.equal(runs[1].eventId, firstRun.eventId);
    assert.equal(runs[1].configVersion, firstRun.configVersion);
    assert.equal(runs[1].stageId, firstRun.stageId);
    assert.deepEqual(invocations, [
      { runId: firstRun.runId, autoCutRunConsent: undefined },
      { runId: runs[1].runId, autoCutRunConsent: runConsent },
    ]);

    const retrySnapshot = fixture.app.aiChat.getThreadSnapshot(completed.threadId);
    assert.notEqual(retrySnapshot.thread.id, firstSnapshot.thread.id);
    assert.equal(retrySnapshot.thread.model, "local-autocut");
    assert.equal(retrySnapshot.runs[0].status, "completed");
    const retryProgress = retrySnapshot.events.filter((event) => event.type === "autocut_progress");
    assert.ok(retryProgress.some((event) => event.data.phase === "document_fetch" && event.data.status === "complete"));
    assert.ok(retryProgress.some((event) => event.data.phase === "artifact_report" && event.data.status === "complete"));
    assert.ok(retryProgress.every((event) => event.runId === runs[1].runId && event.threadId === retrySnapshot.thread.id));
    assert.deepEqual(fixture.app.aiChat.getThreadSnapshot(firstAiRun.threadId), firstSnapshot);
    assert.equal(fixture.app.database.getTaskArtifactForRun(blocked.id, runs[1].runId).validationStatus, "verified");
    for (const [runId, type, phase] of [
      [firstRun.runId, "autocut_progress", "source_hash"],
      [runs[1].runId, "autocut_progress", "private-unknown-phase"],
      [runs[1].runId, "command", "source_asr"],
    ]) {
      fixture.app.database.insertAiChatEvent({
        threadId: retrySnapshot.thread.id, runId, type, role: "activity",
        content: "private-event-text", data: { phase, status: "failed", command: "private-command" },
      });
    }
    const attempts = await jsonRequest(fixture.baseUrl, `/api/local/tasks/${blocked.id}/autocut-runs`,
      undefined, { method: "GET" });
    assert.equal(attempts.response.status, 200);
    assert.deepEqual(attempts.body.runs[0], firstAttempts.body.runs[0], "retry must preserve the first attempt diagnostics");
    assert.equal(attempts.body.runs[1].threadId, retrySnapshot.thread.id);
    assert.equal(attempts.body.runs[1].executionKind, "local");
    assert.equal(attempts.body.runs[1].failedPhase, null, "failure metadata must not cross run bindings");
    assert.equal(attempts.body.runs[1].lastPhase, "artifact_report");
    assert.doesNotMatch(JSON.stringify(attempts.body), /private-unknown-phase|private-event-text|private-command/);
    await assert.rejects(readFile(fixture.promptCapturePath, "utf8"), { code: "ENOENT" });
  } finally {
    await fixture.app.close();
    await fixture.bridge.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

for (const recoveryStatus of ["complete", "resumed"]) {
  test(`Auto-Cut diagnostics ignore a ${recoveryStatus} failure before the next unrecovered phase`, async () => {
    const controlledContext = {
      documentLinks: ["https://guanghe.feishu.cn/docx/recovered-failure"],
      namingDisplayValue: "恢复后失败",
      namingValueUnique: true,
    };
    const fixture = await createFixture({
      controlledContext,
      allowAutomaticExecution: true,
      autoCutRunner: async ({ onProgress }) => {
        onProgress({ phase: "document_fetch", status: "failed" });
        onProgress({ phase: "document_fetch", status: recoveryStatus });
        onProgress({ phase: "asset_download", status: "failed" });
        onProgress({ phase: "package_publish", status: "skipped" });
        onProgress({ phase: "package_publish", status: "failed" });
        const error = new Error("Fixture material download failed");
        error.code = "fixture_asset_download_failed";
        throw error;
      },
    });
    try {
      const subject = await registerSubject(fixture, { executionMode: "automatic" });
      const created = await jsonRequest(fixture.baseUrl, "/api/local/feishu/tasks", registration(subject, controlledContext));
      assert.equal(created.response.status, 201, JSON.stringify(created.body));
      const task = await waitForTaskStatus(fixture.app, created.body.task.id, "blocked", 8_000);
      const attempts = await jsonRequest(fixture.baseUrl, `/api/local/tasks/${task.id}/autocut-runs`,
        undefined, { method: "GET" });
      assert.equal(attempts.response.status, 200);
      assert.equal(attempts.body.runs[0].failedPhase, "asset_download");
      assert.equal(attempts.body.runs[0].lastPhase, "package_publish");
    } finally {
      await fixture.app.close();
      await fixture.bridge.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });
}

test("an automatic phased run with no package ZIP directory uses its frozen subject source through artifact verification", async () => {
  const controlledContext = {
    documentLinks: ["https://guanghe.feishu.cn/docx/frozen-zip-source"],
    namingDisplayValue: "冻结来源目录",
    namingValueUnique: true,
  };
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const invocations = [];
  const fixture = await createFixture({
    controlledContext,
    allowAutomaticExecution: true,
    packageZipSourceDirectory: null,
    autoCutRunner: async ({ run }) => {
      invocations.push(run);
      await writePassingRunResult(run);
    },
  });
  fixture.bridge.holdResponses(gate);
  try {
    const subject = await registerSubject(fixture, { executionMode: "automatic" });
    const created = await jsonRequest(fixture.baseUrl, "/api/local/feishu/tasks", registration(subject, controlledContext));
    assert.equal(created.response.status, 201, JSON.stringify(created.body));
    const snapshot = fixture.app.database.getFeishuTaskPackageSnapshot(created.body.task.id);
    assert.equal(snapshot.zipSourceDirectory, undefined);
    await waitForRun(fixture.app, created.body.task.id, 8_000);
    const newerSource = path.join(fixture.directory, "newer-source");
    await mkdir(newerSource);
    const changed = await jsonRequest(fixture.baseUrl, `/api/local/feishu/workflow/subjects/${encodeURIComponent(SUBJECT_KEY)}`, {
      upload: { ...subject.upload, artifactSourcePath: newerSource },
    }, { method: "PATCH" });
    assert.equal(changed.response.status, 200, JSON.stringify(changed.body));
    release();
    const deadline = Date.now() + 8_000;
    let task;
    do {
      task = fixture.app.database.getTask(created.body.task.id);
      if (["done", "blocked"].includes(task.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    } while (Date.now() < deadline);
    const [run] = fixture.app.database.listFeishuAutoCutRuns(task.id);
    assert.equal(task.status, "done", `${run.errorCode}: ${run.errorMessage}`);
    assert.equal(run.state, "completed");
    assert.equal(invocations.length, 1);
    assert.equal(run.packageZipPath, path.join(await realpath(fixture.zipSourceDirectory), ".taskboard-autocut", task.id, run.runId, `${run.artifactName}.zip`));
    assert.equal(fixture.app.database.getTaskArtifactForRun(task.id, run.runId).validationStatus, "verified");
    assert.deepEqual(fixture.app.database.getFeishuTaskPackageSnapshot(task.id), snapshot);
  } finally {
    release();
    await fixture.app.close();
    await fixture.bridge.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("switch off then on during input preparation cancels the old automatic start", async () => {
  const controlledContext = {
    documentLinks: ["https://guanghe.feishu.cn/docx/switch-race"],
    namingDisplayValue: "开关准备阶段测试", namingValueUnique: true,
  };
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let starts = 0;
  const fixture = await createFixture({ controlledContext, allowAutomaticExecution: true,
    autoCutRunner: async ({ run }) => { starts += 1; await writePassingRunResult(run); } });
  fixture.bridge.holdResponses(gate);
  const save = (enabled, expectedVersion) => jsonRequest(fixture.baseUrl,
    "/api/local/settings/automatic-execution", { enabled, expectedVersion },
    { method: "PUT", headers: { "x-taskboard-client": "web" } });
  try {
    const subject = await registerSubject(fixture, { executionMode: "automatic" });
    const created = await jsonRequest(fixture.baseUrl, "/api/local/feishu/tasks", registration(subject, controlledContext));
    const taskId = created.body.task.id;
    await waitForRun(fixture.app, taskId, 8_000);
    assert.equal((await save(false, 1)).response.status, 200);
    assert.equal((await save(true, 2)).response.status, 200);
    release();
    await waitForTaskStatus(fixture.app, taskId, "todo");
    assert.equal(starts, 0);
    const run = fixture.app.database.listFeishuAutoCutRuns(taskId)[0];
    assert.equal(fixture.app.database.getAiChatRun(run.runId).status, "interrupted");
    assert.equal(fixture.app.database.getTaskAiStartForArtifactReport(taskId, run.runId), null);
    assert.equal(fixture.app.database.getFeishuExecution(taskId), null);
  } finally {
    release();
    await fixture.app.close(); await fixture.bridge.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("local switch cancels waiting automatic tasks while a running edit completes", async () => {
  const controlledContext = {
    documentLinks: ["https://guanghe.feishu.cn/docx/switch-queue"],
    namingDisplayValue: "队列开关测试", namingValueUnique: true,
  };
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let started = false;
  const fixture = await createFixture({ controlledContext, allowAutomaticExecution: true,
    autoCutRunner: async ({ run }) => { started = true; await gate; await writePassingRunResult(run); } });
  const save = (enabled, expectedVersion) => jsonRequest(fixture.baseUrl,
    "/api/local/settings/automatic-execution", { enabled, expectedVersion },
    { method: "PUT", headers: { "x-taskboard-client": "web" } });
  try {
    const subject = await registerSubject(fixture, { executionMode: "automatic" });
    const waiting = await jsonRequest(fixture.baseUrl, "/api/local/feishu/tasks", registration(subject, controlledContext));
    assert.equal((await save(false, 1)).response.status, 200);
    assert.equal(fixture.app.database.getFeishuExecution(waiting.body.task.id), null);
    assert.equal((await save(true, 2)).response.status, 200);
    assert.equal(fixture.app.database.getFeishuExecution(waiting.body.task.id), null);
    const next = registration(subject, controlledContext);
    next.event.eventId = "evt-switch-second";
    next.event.recordId = "rec_switch_second";
    const running = await jsonRequest(fixture.baseUrl, "/api/local/feishu/tasks", next);
    const deadline = Date.now() + 30_000;
    while (!started && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(started, true);
    assert.equal((await save(false, 3)).response.status, 200);
    release();
    await waitForTaskStatus(fixture.app, running.body.task.id, "done");
    assert.equal(fixture.app.database.getTask(waiting.body.task.id).status, "todo");
    assert.equal(fixture.app.database.listFeishuAutoCutRuns(waiting.body.task.id).length, 0);
  } finally {
    release();
    await fixture.app.close(); await fixture.bridge.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("initial automatic preflight failure blocks the attempt and releases its claim", async () => {
  const controlledContext = {
    documentLinks: ["https://guanghe.feishu.cn/docx/automatic-preflight-failure"],
    namingDisplayValue: "自动预检失败",
    namingValueUnique: true,
  };
  const fixture = await createFixture({
    controlledContext,
    allowAutomaticExecution: true,
    autoCutRunner: async () => {
      const error = new Error("Auto-Cut Lark CLI is unavailable");
      error.code = "AUTOCUT_LARK_CLI_UNAVAILABLE";
      throw error;
    },
  });
  try {
    const subject = await registerSubject(fixture, { executionMode: "automatic" });
    const created = await jsonRequest(fixture.baseUrl, "/api/local/feishu/tasks", registration(subject, controlledContext));
    assert.equal(created.response.status, 201, JSON.stringify(created.body));
    const task = await waitForTaskStatus(fixture.app, created.body.task.id, "blocked", 8_000);
    const [run] = fixture.app.database.listFeishuAutoCutRuns(task.id);
    assert.equal(run.state, "blocked");
    assert.equal(run.errorCode, "AUTOCUT_LARK_CLI_UNAVAILABLE");
    assert.equal(fixture.app.database.getAiChatRun(run.runId).status, "failed");
    assert.equal(fixture.app.database.getTaskAiStartForArtifactReport(task.id, run.runId), null);
    assert.equal(fixture.app.database.getFeishuExecution(task.id), null);
    await assert.rejects(readFile(fixture.promptCapturePath, "utf8"), { code: "ENOENT" });
  } finally {
    await fixture.app.close();
    await fixture.bridge.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("a recovered automatic phased reservation runs locally after policy revalidation", async () => {
  const controlledContext = {
    documentLinks: ["https://guanghe.feishu.cn/docx/recovered-automatic-runner"],
    namingDisplayValue: "恢复自动本机执行",
    namingValueUnique: true,
  };
  const invocations = [];
  const fixture = await createFixture({
    controlledContext,
    allowAutomaticExecution: true,
    autoCutRunner: async ({ run }) => {
      invocations.push(run.runId);
      await writePassingRunResult(run);
      return { exitCode: 0 };
    },
  });
  try {
    const subject = await registerSubject(fixture, { executionMode: "automatic" });
    const created = await jsonRequest(fixture.baseUrl, "/api/local/feishu/tasks", registration(subject, controlledContext));
    assert.equal(created.response.status, 201, JSON.stringify(created.body));
    assert.equal(fixture.app.database.getFeishuExecution(created.body.task.id)?.state, "delayed");
    await fixture.app.close();
    fixture.app = createTaskboardServer(fixture.serverOptions);
    await listenTaskboardOnFetchSafePort(fixture.app);
    const task = await waitForTaskStatus(fixture.app, created.body.task.id, "done", 30_000);
    const [run] = fixture.app.database.listFeishuAutoCutRuns(task.id);
    assert.deepEqual(invocations, [run.runId]);
    assert.equal(run.state, "completed");
    await assert.rejects(readFile(fixture.promptCapturePath, "utf8"), { code: "ENOENT" });
  } finally {
    await fixture.app.close();
    await fixture.bridge.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

for (const [scenario, allowAutomaticExecution, simulation] of [
  ["disabled local automatic execution", false, false],
  ["simulated delivery", true, true],
]) {
  test(`${scenario} cannot invoke the local Auto-Cut runner`, async () => {
    const controlledContext = {
      documentLinks: ["https://guanghe.feishu.cn/docx/automatic-policy"],
      namingDisplayValue: "自动策略边界",
      namingValueUnique: true,
    };
    let invocations = 0;
    const fixture = await createFixture({
      controlledContext,
      allowAutomaticExecution,
      autoCutRunner: async () => { invocations += 1; },
    });
    try {
      const subject = await registerSubject(fixture, { executionMode: "automatic" });
      const body = registration(subject, controlledContext);
      if (simulation) body.event.deliverySource = "simulation";
      const created = await jsonRequest(fixture.baseUrl, "/api/local/feishu/tasks", body);
      assert.equal(created.response.status, 201, JSON.stringify(created.body));
      assert.equal(created.body.task.status, "todo");
      assert.equal(fixture.app.database.getFeishuExecution(created.body.task.id), null);
      assert.deepEqual(fixture.app.database.listFeishuAutoCutRuns(created.body.task.id), []);
      assert.equal(invocations, 0);
      await assert.rejects(readFile(fixture.promptCapturePath, "utf8"), { code: "ENOENT" });
    } finally {
      await fixture.app.close();
      await fixture.bridge.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });
}

for (const [failure, expectedCode] of [
  ["http-error", "AUTOCUT_ARTIFACT_REPORT_FAILED"],
  ["connection-error", "AUTOCUT_ARTIFACT_REPORT_FAILED"],
  ["timeout", "AUTOCUT_ARTIFACT_REPORT_TIMEOUT"],
  ["body-timeout", "AUTOCUT_ARTIFACT_REPORT_TIMEOUT"],
  ["invalid-success", "AUTOCUT_ARTIFACT_REPORT_INVALID"],
]) {
  test(`local artifact report ${failure} blocks the attempt and releases its claim`, async (t) => {
    const controlledContext = {
      documentLinks: ["https://guanghe.feishu.cn/docx/local-report-failure"],
      namingDisplayValue: "本机制品登记失败",
      namingValueUnique: true,
    };
    const fixture = await createFixture({
      controlledContext,
      localAutoCutArtifactReportTimeoutMs: 40,
      autoCutRunner: async ({ run }) => {
        await writePassingRunResult(run);
        return { exitCode: 0 };
      },
    });
    let reportRequests = 0;
    try {
      const subject = await registerSubject(fixture);
      const created = await jsonRequest(fixture.baseUrl, "/api/local/feishu/tasks", registration(subject, controlledContext));
      await jsonRequest(fixture.baseUrl, `/api/tasks/${created.body.task.id}/start-ai`, {});
      const blocked = await waitForTaskStatus(fixture.app, created.body.task.id, "blocked");
      const originalFetch = globalThis.fetch;
      t.mock.method(globalThis, "fetch", async (input, init) => {
        if (init?.headers?.["x-taskboard-client"] !== "taskctl") return originalFetch(input, init);
        reportRequests += 1;
        if (failure === "http-error") {
          return new Response(JSON.stringify({ error: { message: "private-path-and-secret" } }), { status: 503 });
        }
        if (failure === "connection-error") throw new TypeError("private-path-and-secret");
        if (failure === "body-timeout") {
          return new Response(new ReadableStream({
            start(controller) {
              const timer = setTimeout(() => {
                controller.enqueue(new TextEncoder().encode("{}"));
                controller.close();
              }, 200);
              init?.signal?.addEventListener("abort", () => {
                clearTimeout(timer);
                controller.error(init.signal.reason);
              }, { once: true });
            },
          }));
        }
        if (failure === "timeout") {
          return new Promise((resolve, reject) => {
            const timer = setTimeout(() => resolve(new Response("{}", { status: 200 })), 200);
            init?.signal?.addEventListener("abort", () => {
              clearTimeout(timer);
              reject(init.signal.reason);
            }, { once: true });
          });
        }
        return new Response(JSON.stringify({ artifact: { id: "foreign-artifact" } }), { status: 200 });
      });
      const retried = await jsonRequest(fixture.baseUrl, `/api/local/tasks/${blocked.id}/autocut-retry`, {
        version: blocked.version,
        runConsent: { allowVideoAudioAsr: true, allowConfiguredLocalOutput: true },
      });
      assert.equal(retried.response.status, 202, JSON.stringify(retried.body));
      await waitForTaskStatus(fixture.app, blocked.id, "blocked");
      const run = fixture.app.database.listFeishuAutoCutRuns(blocked.id)[1];
      assert.equal(reportRequests, 1);
      assert.equal(run.errorCode, expectedCode);
      assert.doesNotMatch(run.errorMessage, /private-path-and-secret/);
      assert.equal(fixture.app.database.getAiChatRun(run.runId).status, "failed");
      assert.equal(fixture.app.database.getTaskArtifactForRun(blocked.id, run.runId), null);
      assert.equal(fixture.app.database.getTaskAiStartForArtifactReport(blocked.id, run.runId), null);
      assert.equal(fixture.app.database.getFeishuExecution(blocked.id), null);
    } finally {
      await fixture.app.close();
      await fixture.bridge.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });
}

for (const missingPackageZipDirectory of [false, true]) {
test(`an authorized phased retry runs locally without starting another Codex turn${missingPackageZipDirectory ? " with a frozen subject ZIP source" : ""}`, async () => {
  const controlledContext = {
    documentLinks: ["https://guanghe.feishu.cn/docx/taskboard-owned-runner"],
    namingDisplayValue: "课程000",
    namingValueUnique: true,
  };
  const invocations = [];
  let fixture;
  fixture = await createFixture({
    controlledContext,
    allowAutomaticExecution: true,
    packageZipSourceDirectory: missingPackageZipDirectory ? null : undefined,
    autoCutRunner: async ({ run }) => {
      invocations.push(run.runId);
      await writePassingRunResult(run);
      return { exitCode: 0 };
    },
  });
  try {
    const subject = await registerSubject(fixture, {
      executionMode: "automatic",
      enqueueMode: "automatic",
    });
    const created = await jsonRequest(
      fixture.baseUrl,
      "/api/local/feishu/tasks",
      registration(subject, controlledContext),
    );
    assert.equal(created.response.status, 201, JSON.stringify(created.body));
    const firstStart = await jsonRequest(
      fixture.baseUrl,
      `/api/tasks/${created.body.task.id}/start-ai`,
      {},
    );
    assert.equal(firstStart.response.status, 202, JSON.stringify(firstStart.body));
    const [firstRun] = await waitForRuns(fixture.app, created.body.task.id, 1);
    const blocked = await waitForTaskStatus(fixture.app, created.body.task.id, "blocked");
    assert.deepEqual(invocations, []);
    assert.equal((await readFile(fixture.promptCapturePath, "utf8")).includes("trusted package prompt"), true);

    const retried = await jsonRequest(
      fixture.baseUrl,
      `/api/local/tasks/${encodeURIComponent(blocked.id)}/autocut-retry`,
      {
        version: blocked.version,
        runConsent: {
          allowVideoAudioAsr: true,
          allowConfiguredLocalOutput: true,
        },
      },
    );
    assert.equal(retried.response.status, 202, JSON.stringify(retried.body));
    assert.equal(retried.body.execution.trigger, "retry");
    const runs = await waitForRuns(fixture.app, created.body.task.id, 2);
    const run = runs[1];
    assert.notEqual(run.runId, firstRun.runId);
    await waitForTaskStatus(fixture.app, created.body.task.id, "done");
    assert.deepEqual(invocations, [run.runId]);
    assert.ok(fixture.app.database.listAiChatEvents(retried.body.thread.id).some(
      (event) => event.type === "autocut_progress" && event.data.phase === "artifact_report" && event.data.status === "complete",
    ));
    const artifact = fixture.app.database.getTaskArtifactForRun(created.body.task.id, run.runId);
    assert.equal(artifact?.validationStatus, "verified");
    assert.equal(fixture.app.database.listTaskArtifactUploads(created.body.task.id).length, 1);
    assert.equal(fixture.app.database.listAiChatRuns(firstStart.body.thread.id).length, 1);
  } finally {
    await fixture.app.close();
    await fixture.bridge.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});
}

test("local runner receives deadline options without inheriting Taskboard launcher variables", async () => {
  const controlledContext = {
    documentLinks: ["https://guanghe.feishu.cn/docx/local-runner-deadlines"],
    namingDisplayValue: "运行期限",
    namingValueUnique: true,
  };
  let invocation;
  const fixture = await createFixture({
    controlledContext,
    processEnvironmentOverrides: {
      CODEX_TASKBOARD_AUTOCUT_ENVIRONMENT_TIMEOUT_MS: "45000",
      CODEX_TASKBOARD_AUTOCUT_PREFLIGHT_TIMEOUT_MS: "180000",
      CODEX_TASKBOARD_AUTOCUT_RUN_TIMEOUT_MS: "10800000",
      CODEX_TASKBOARD_INSTANCE_SECRET: "private-launcher-secret",
    },
    autoCutRunner: async (options) => {
      invocation = options;
      await writePassingRunResult(options.run);
      return { exitCode: 0 };
    },
  });
  try {
    const subject = await registerSubject(fixture);
    const created = await jsonRequest(fixture.baseUrl, "/api/local/feishu/tasks", registration(subject, controlledContext));
    await jsonRequest(fixture.baseUrl, `/api/tasks/${created.body.task.id}/start-ai`, {});
    const blocked = await waitForTaskStatus(fixture.app, created.body.task.id, "blocked");
    const retried = await jsonRequest(fixture.baseUrl, `/api/local/tasks/${blocked.id}/autocut-retry`, {
      version: blocked.version,
      runConsent: { allowVideoAudioAsr: true, allowConfiguredLocalOutput: true },
    });
    assert.equal(retried.response.status, 202, JSON.stringify(retried.body));
    await waitForTaskStatus(fixture.app, blocked.id, "in_review");
    assert.equal(invocation.environmentTimeoutMs, 45000);
    assert.equal(invocation.preflightTimeoutMs, 180000);
    assert.equal(invocation.runTimeoutMs, 10800000);
    assert.deepEqual(Object.keys(invocation.environment).filter((key) => key.startsWith("CODEX_TASKBOARD_")), []);
    assert.equal(invocation.environment.CODEX_FEISHU_BRIDGE_SECRET, undefined);
  } finally {
    await fixture.app.close();
    await fixture.bridge.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

for (const outcome of ["success", "environment-failure", "interrupted", "blocked-receipt", "registration-failure"]) {
  test(`local execution publishes safe progress and a terminal notification: ${outcome}`, async () => {
    const controlledContext = {
      documentLinks: ["https://guanghe.feishu.cn/docx/progress-fixture"],
      namingDisplayValue: "阶段通知测试", namingValueUnique: true,
    };
    const notifications = [];
    let lateProgress;
    let unsubscribe;
    let fixture;
    fixture = await createFixture({
      controlledContext,
      autoCutRunner: async ({ run, onProgress }) => {
        const threadId = fixture.app.database.getAiChatRun(run.runId).threadId;
        unsubscribe = fixture.app.aiChat.subscribe(threadId, (event) => notifications.push(event));
        lateProgress = onProgress;
        onProgress({ phase: "preflight", status: "running", message: "private-secret", path: "private-path" });
        onProgress({ phase: "preflight", status: "running" });
        onProgress({ phase: "unknown-private-secret", status: "running" });
        onProgress({ phase: "preflight", status: "private-secret" });
        if (outcome === "environment-failure" || outcome === "interrupted") {
          const error = new Error(outcome === "interrupted" ? "Auto-Cut was interrupted" : "Configured CLI cannot be accessed");
          error.code = outcome === "interrupted" ? "AUTOCUT_RUN_INTERRUPTED" : "AUTOCUT_LARK_CLI_UNAVAILABLE";
          throw error;
        }
        onProgress({ phase: "preflight", status: "complete" });
        if (outcome === "blocked-receipt") {
          await writeFile(run.resultPath, JSON.stringify({
            schema_version: 1, binding: runBinding(run), manifest_sha256: run.manifestSha256,
            status: "blocked", error: { code: "fixture_preflight_failed", message: "Preflight blocked" },
          }));
        } else {
          await writePassingRunResult(run, { includePackageReceipt: outcome !== "registration-failure" });
        }
      },
    });
    try {
      const subject = await registerSubject(fixture);
      const created = await jsonRequest(fixture.baseUrl, "/api/local/feishu/tasks", registration(subject, controlledContext));
      await jsonRequest(fixture.baseUrl, `/api/tasks/${created.body.task.id}/start-ai`, {});
      const blocked = await waitForTaskStatus(fixture.app, created.body.task.id, "blocked");
      const retried = await jsonRequest(fixture.baseUrl, `/api/local/tasks/${blocked.id}/autocut-retry`, {
        version: blocked.version, runConsent: { allowVideoAudioAsr: true, allowConfiguredLocalOutput: true },
      });
      assert.equal(retried.response.status, 202, JSON.stringify(retried.body));
      await waitForTaskStatus(fixture.app, blocked.id, outcome === "success" ? "in_review" : "blocked");
      const snapshot = fixture.app.aiChat.getThreadSnapshot(retried.body.thread.id);
      const expectedStatus = outcome === "success" ? "completed" : outcome === "interrupted" ? "interrupted" : "failed";
      assert.equal(snapshot.runs[0].status, expectedStatus);
      assert.notEqual(snapshot.thread.status, "running");
      assert.ok(notifications.some((event) => event.type === "ai.run" && event.run.status === expectedStatus));
      const progress = snapshot.events.filter((event) => event.type === "autocut_progress");
      assert.equal(progress.filter((event) => event.data.phase === "preflight" && event.data.status === "running").length, 1);
      assert.ok(progress.every((event) => event.runId === retried.body.run.id && event.threadId === retried.body.thread.id));
      assert.ok(notifications.some((event) => event.type === "ai.event" && event.event.type === "autocut_progress"));
      assert.doesNotMatch(JSON.stringify(progress), /private-secret|private-path/);
      const eventCount = snapshot.events.length;
      lateProgress({ phase: "source_asr", status: "running" });
      assert.equal(fixture.app.aiChat.getThreadSnapshot(retried.body.thread.id).events.length, eventCount);
      if (outcome === "blocked-receipt") {
        // Pre-fix local runners stored exit-0 blocked results as AI completed.
        fixture.app.database.updateAiChatRun(retried.body.run.id, { status: "completed", exitCode: 0, error: null });
        const legacySnapshot = fixture.app.aiChat.getThreadSnapshot(retried.body.thread.id);
        assert.equal(legacySnapshot.runs[0].status, "failed");
        assert.equal(legacySnapshot.runs[0].error, "Preflight blocked");
        assert.equal(fixture.app.database.getAiChatRun(retried.body.run.id).status, "completed", "display must not rewrite history");
      }
    } finally {
      unsubscribe?.();
      await fixture.app.close();
      await fixture.bridge.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });
}

test("local preparation failure publishes a terminal thread notification", async (t) => {
  const controlledContext = {
    documentLinks: ["https://guanghe.feishu.cn/docx/progress-prepare"],
    namingDisplayValue: "准备失败通知", namingValueUnique: true,
  };
  const fixture = await createFixture({ controlledContext, autoCutRunner: async () => assert.fail("runner must not start") });
  const notifications = [];
  let unsubscribe;
  try {
    const subject = await registerSubject(fixture);
    const created = await jsonRequest(fixture.baseUrl, "/api/local/feishu/tasks", registration(subject, controlledContext));
    await jsonRequest(fixture.baseUrl, `/api/tasks/${created.body.task.id}/start-ai`, {});
    const blocked = await waitForTaskStatus(fixture.app, created.body.task.id, "blocked");
    const createRun = fixture.app.database.createAiChatRun.bind(fixture.app.database);
    t.mock.method(fixture.app.database, "createAiChatRun", (input) => {
      const run = createRun(input);
      unsubscribe = fixture.app.aiChat.subscribe(run.threadId, (event) => notifications.push(event));
      return run;
    });
    fixture.bridge.setResponse("controlled_context_unavailable", 503);
    const retried = await jsonRequest(fixture.baseUrl, `/api/local/tasks/${blocked.id}/autocut-retry`, {
      version: blocked.version, runConsent: { allowVideoAudioAsr: true, allowConfiguredLocalOutput: true },
    });
    assert.ok(retried.response.status >= 400);
    const run = fixture.app.database.listFeishuAutoCutRuns(blocked.id)[1];
    assert.equal(fixture.app.database.getAiChatRun(run.runId).status, "failed");
    assert.ok(notifications.some((event) => event.type === "ai.run" && event.run.status === "running"));
    assert.ok(notifications.some((event) => event.type === "ai.run" && event.run.status === "failed"));
    assert.ok(notifications.some((event) => event.type === "ai.event" && event.event.data?.status === "failed"));
  } finally {
    unsubscribe?.();
    await fixture.app.close();
    await fixture.bridge.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("a consent-free phased retry retains the Codex path", async () => {
  const controlledContext = {
    documentLinks: ["https://guanghe.feishu.cn/docx/consent-free-retry"],
    namingDisplayValue: "无授权重试",
    namingValueUnique: true,
  };
  let localInvocations = 0;
  const fixture = await createFixture({
    controlledContext,
    autoCutRunner: async () => { localInvocations += 1; },
  });
  try {
    const subject = await registerSubject(fixture);
    const created = await jsonRequest(fixture.baseUrl, "/api/local/feishu/tasks", registration(subject, controlledContext));
    await jsonRequest(fixture.baseUrl, `/api/tasks/${created.body.task.id}/start-ai`, {});
    const blocked = await waitForTaskStatus(fixture.app, created.body.task.id, "blocked");
    const retried = await jsonRequest(fixture.baseUrl, `/api/local/tasks/${blocked.id}/autocut-retry`, {
      version: blocked.version,
    });
    assert.equal(retried.response.status, 202, JSON.stringify(retried.body));
    await waitForTaskStatus(fixture.app, blocked.id, "blocked");
    assert.equal(fixture.app.database.listFeishuAutoCutRuns(blocked.id).length, 2);
    assert.equal(localInvocations, 0);
    assert.notEqual(fixture.app.database.getAiChatThread(retried.body.thread.id).model, "local-autocut");
    assert.match(await readFile(fixture.promptCapturePath, "utf8"), /trusted package prompt/);
  } finally {
    await fixture.app.close();
    await fixture.bridge.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("records a local Auto-Cut interruption as an interrupted AI run", async () => {
  const controlledContext = {
    documentLinks: ["https://guanghe.feishu.cn/docx/interrupted-run"],
    namingDisplayValue: "课程中断",
    namingValueUnique: true,
  };
  const fixture = await createFixture({
    controlledContext,
    autoCutRunner: async () => {
      const error = new Error("Auto-Cut was interrupted because Taskboard is shutting down");
      error.code = "AUTOCUT_RUN_INTERRUPTED";
      throw error;
    },
  });
  try {
    const subject = await registerSubject(fixture);
    const created = await jsonRequest(
      fixture.baseUrl,
      "/api/local/feishu/tasks",
      registration(subject, controlledContext),
    );
    assert.equal(created.response.status, 201, JSON.stringify(created.body));
    const initial = await jsonRequest(fixture.baseUrl, `/api/tasks/${created.body.task.id}/start-ai`, {});
    assert.equal(initial.response.status, 202, JSON.stringify(initial.body));
    const blocked = await waitForTaskStatus(fixture.app, created.body.task.id, "blocked");

    const retried = await jsonRequest(
      fixture.baseUrl,
      `/api/local/tasks/${encodeURIComponent(blocked.id)}/autocut-retry`,
      {
        version: blocked.version,
        runConsent: {
          allowVideoAudioAsr: true,
          allowConfiguredLocalOutput: true,
        },
      },
    );
    assert.equal(retried.response.status, 202, JSON.stringify(retried.body));
    await waitForTaskStatus(fixture.app, created.body.task.id, "blocked");
    const [run] = fixture.app.database.listAiChatRuns(retried.body.thread.id);
    assert.equal(run.status, "interrupted");
  } finally {
    await fixture.app.close();
    await fixture.bridge.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("archiving a running local Auto-Cut task interrupts it and allows permanent deletion", async () => {
  const controlledContext = {
    documentLinks: ["https://guanghe.feishu.cn/docx/archive-running-local-run"],
    namingDisplayValue: "归档中断课程",
    namingValueUnique: true,
  };
  let runnerStarted;
  const started = new Promise((resolve) => { runnerStarted = resolve; });
  const fixture = await createFixture({
    controlledContext,
    allowAutomaticExecution: true,
    autoCutRunner: async ({ signal }) => {
      runnerStarted();
      await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
      const error = new Error("Auto-Cut was interrupted because its task was archived");
      error.code = "AUTOCUT_RUN_INTERRUPTED";
      throw error;
    },
  });
  try {
    const subject = await registerSubject(fixture, { executionMode: "automatic" });
    const created = await jsonRequest(
      fixture.baseUrl,
      "/api/local/feishu/tasks",
      registration(subject, controlledContext),
    );
    assert.equal(created.response.status, 201, JSON.stringify(created.body));
    const run = await waitForRun(fixture.app, created.body.task.id, 8_000);
    await started;

    const current = fixture.app.database.getTask(created.body.task.id);
    const archived = await jsonRequest(
      fixture.baseUrl,
      `/api/tasks/${encodeURIComponent(current.id)}/archive`,
      { version: current.version },
    );
    assert.equal(archived.response.status, 200, JSON.stringify(archived.body));

    assert.equal(fixture.app.database.getAiChatRun(run.runId)?.status, "interrupted");
    assert.equal(fixture.app.database.getFeishuAutoCutRun(run.runId)?.state, "blocked");
    assert.equal(fixture.app.database.listTaskAiStarts().some((claim) => claim.taskId === current.id), false);
    assert.equal(fixture.app.database.getFeishuExecution(current.id), null);

    const deleted = await jsonRequest(
      fixture.baseUrl,
      `/api/tasks/${encodeURIComponent(current.id)}`,
      { version: fixture.app.database.getTask(current.id).version },
      { method: "DELETE" },
    );
    assert.equal(deleted.response.status, 204, JSON.stringify(deleted.body));
  } finally {
    await fixture.app.close();
    await fixture.bridge.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("interrupting a running local Auto-Cut run stops its task-level execution", async () => {
  const controlledContext = {
    documentLinks: ["https://guanghe.feishu.cn/docx/interrupt-running-local-run"],
    namingDisplayValue: "手动停止课程",
    namingValueUnique: true,
  };
  let runnerStarted;
  const started = new Promise((resolve) => { runnerStarted = resolve; });
  const fixture = await createFixture({
    controlledContext,
    allowAutomaticExecution: true,
    autoCutRunner: async ({ signal }) => {
      runnerStarted();
      await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
      const error = new Error("Auto-Cut was interrupted by the operator");
      error.code = "AUTOCUT_RUN_INTERRUPTED";
      throw error;
    },
  });
  try {
    const subject = await registerSubject(fixture, { executionMode: "automatic" });
    const created = await jsonRequest(
      fixture.baseUrl,
      "/api/local/feishu/tasks",
      registration(subject, controlledContext),
    );
    assert.equal(created.response.status, 201, JSON.stringify(created.body));
    const run = await waitForRun(fixture.app, created.body.task.id, 8_000);
    await started;

    const interrupted = await jsonRequest(
      fixture.baseUrl,
      `/api/local/ai/runs/${encodeURIComponent(run.runId)}/interrupt`,
      undefined,
      { method: "POST" },
    );
    assert.equal(interrupted.response.status, 200, JSON.stringify(interrupted.body));
    assert.equal(interrupted.body.run.status, "interrupted");
    assert.equal(fixture.app.database.getFeishuAutoCutRun(run.runId)?.state, "blocked");
    assert.equal(fixture.app.database.getTask(created.body.task.id)?.status, "blocked");
    assert.equal(fixture.app.database.listTaskAiStarts().some((claim) => claim.taskId === created.body.task.id), false);
    assert.equal(fixture.app.database.getFeishuExecution(created.body.task.id), null);
  } finally {
    await fixture.app.close();
    await fixture.bridge.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("archiving a local Auto-Cut task during input preparation prevents the runner from starting", async () => {
  const controlledContext = {
    documentLinks: ["https://guanghe.feishu.cn/docx/archive-input-prepare"],
    namingDisplayValue: "准备阶段归档课程",
    namingValueUnique: true,
  };
  let releaseBridge;
  const bridgeGate = new Promise((resolve) => { releaseBridge = resolve; });
  let runnerCalls = 0;
  const fixture = await createFixture({
    controlledContext,
    allowAutomaticExecution: true,
    autoCutRunner: async () => { runnerCalls += 1; },
  });
  try {
    const subject = await registerSubject(fixture, { executionMode: "automatic" });
    fixture.bridge.holdResponses(bridgeGate);
    const payload = registration(subject, controlledContext);
    const registered = jsonRequest(
      fixture.baseUrl,
      "/api/local/feishu/tasks",
      payload,
    );
    const taskIdentity = {
      baseToken: payload.event.baseToken,
      tableId: payload.event.tableId,
      recordId: payload.event.recordId,
      statusFieldId: payload.event.statusFieldId,
      stageId: payload.binding.stageId,
      eventId: payload.event.eventId,
    };
    const taskDeadline = Date.now() + 5_000;
    let task = null;
    while (!task && Date.now() < taskDeadline) {
      task = fixture.app.database.findFeishuTaskByRegistration(taskIdentity);
      if (!task) await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.ok(task, "expected automatic Feishu registration to create its task");
    const deadline = Date.now() + 8_000;
    while (fixture.bridge.requests.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(fixture.bridge.requests.length, 1, "expected input preparation to request controlled context");
    const run = await waitForRun(fixture.app, task.id);
    const current = fixture.app.database.getTask(task.id);
    const archived = await jsonRequest(
      fixture.baseUrl,
      `/api/tasks/${encodeURIComponent(current.id)}/archive`,
      { version: current.version },
    );
    assert.equal(archived.response.status, 200, JSON.stringify(archived.body));

    assert.equal(runnerCalls, 0);
    assert.equal(fixture.app.database.getAiChatRun(run.runId)?.status, "interrupted");
    assert.equal(fixture.app.database.getFeishuAutoCutRun(run.runId)?.state, "blocked");
    assert.equal(fixture.app.database.listTaskAiStarts().some((claim) => claim.taskId === current.id), false);
    assert.equal(fixture.app.database.getFeishuExecution(current.id), null);
    const deleted = await jsonRequest(
      fixture.baseUrl,
      `/api/tasks/${encodeURIComponent(current.id)}`,
      { version: fixture.app.database.getTask(current.id).version },
      { method: "DELETE" },
    );
    assert.equal(deleted.response.status, 204, JSON.stringify(deleted.body));
    releaseBridge();
    const created = await registered;
    assert.equal(created.response.status, 201, JSON.stringify(created.body));
  } finally {
    releaseBridge?.();
    await fixture.app.close();
    await fixture.bridge.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("interrupting a local Auto-Cut run during input preparation prevents the runner from starting", async () => {
  const controlledContext = {
    documentLinks: ["https://guanghe.feishu.cn/docx/interrupt-input-prepare"],
    namingDisplayValue: "准备阶段停止课程",
    namingValueUnique: true,
  };
  let releaseBridge;
  const bridgeGate = new Promise((resolve) => { releaseBridge = resolve; });
  let runnerCalls = 0;
  const fixture = await createFixture({
    controlledContext,
    allowAutomaticExecution: true,
    autoCutRunner: async () => { runnerCalls += 1; },
  });
  try {
    const subject = await registerSubject(fixture, { executionMode: "automatic" });
    fixture.bridge.holdResponses(bridgeGate);
    const payload = registration(subject, controlledContext);
    const registered = jsonRequest(
      fixture.baseUrl,
      "/api/local/feishu/tasks",
      payload,
    );
    const taskIdentity = {
      baseToken: payload.event.baseToken,
      tableId: payload.event.tableId,
      recordId: payload.event.recordId,
      statusFieldId: payload.event.statusFieldId,
      stageId: payload.binding.stageId,
      eventId: payload.event.eventId,
    };
    const taskDeadline = Date.now() + 5_000;
    let task = null;
    while (!task && Date.now() < taskDeadline) {
      task = fixture.app.database.findFeishuTaskByRegistration(taskIdentity);
      if (!task) await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.ok(task, "expected automatic Feishu registration to create its task");
    const deadline = Date.now() + 8_000;
    while (fixture.bridge.requests.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(fixture.bridge.requests.length, 1, "expected input preparation to request controlled context");
    const run = await waitForRun(fixture.app, task.id);
    const interrupted = await jsonRequest(
      fixture.baseUrl,
      `/api/local/ai/runs/${encodeURIComponent(run.runId)}/interrupt`,
      undefined,
      { method: "POST" },
    );
    assert.equal(interrupted.response.status, 200, JSON.stringify(interrupted.body));

    assert.equal(runnerCalls, 0);
    assert.equal(interrupted.body.run.status, "interrupted");
    assert.equal(fixture.app.database.getFeishuAutoCutRun(run.runId)?.state, "blocked");
    assert.equal(fixture.app.database.getTask(task.id)?.status, "blocked");
    assert.equal(fixture.app.database.listTaskAiStarts().some((claim) => claim.taskId === task.id), false);
    assert.equal(fixture.app.database.getFeishuExecution(task.id), null);
    releaseBridge();
    const created = await registered;
    assert.equal(created.response.status, 201, JSON.stringify(created.body));
  } finally {
    releaseBridge?.();
    await fixture.app.close();
    await fixture.bridge.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("keeps the local listener available until a prepared Auto-Cut report finishes during shutdown", async () => {
  const controlledContext = {
    documentLinks: ["https://guanghe.feishu.cn/docx/shutdown-report"],
    namingDisplayValue: "课程关闭",
    namingValueUnique: true,
  };
  let signalReady;
  const waitForAbort = new Promise((resolve) => { signalReady = resolve; });
  let fixtureClosed = false;
  const fixture = await createFixture({
    controlledContext,
    autoCutRunner: async ({ run, signal }) => {
      await writePassingRunResult(run);
      signalReady(run);
      await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
      return { exitCode: 0 };
    },
  });
  try {
    const subject = await registerSubject(fixture, {
      executionMode: "automatic",
      enqueueMode: "automatic",
    });
    const created = await jsonRequest(
      fixture.baseUrl,
      "/api/local/feishu/tasks",
      registration(subject, controlledContext),
    );
    assert.equal(created.response.status, 201, JSON.stringify(created.body));
    const initial = await jsonRequest(fixture.baseUrl, `/api/tasks/${created.body.task.id}/start-ai`, {});
    assert.equal(initial.response.status, 202, JSON.stringify(initial.body));
    const blocked = await waitForTaskStatus(fixture.app, created.body.task.id, "blocked");

    const retried = await jsonRequest(
      fixture.baseUrl,
      `/api/local/tasks/${encodeURIComponent(blocked.id)}/autocut-retry`,
      {
        version: blocked.version,
        runConsent: {
          allowVideoAudioAsr: true,
          allowConfiguredLocalOutput: true,
        },
      },
    );
    assert.equal(retried.response.status, 202, JSON.stringify(retried.body));
    const run = await waitForAbort;
    await fixture.app.close();
    fixtureClosed = true;

    const database = new TaskboardDatabase(path.join(fixture.directory, "taskboard.sqlite"));
    try {
      assert.equal(database.getTask(created.body.task.id).status, "done");
      assert.equal(database.getFeishuAutoCutRun(run.runId).state, "completed");
      assert.equal(database.getTaskArtifactForRun(created.body.task.id, run.runId)?.validationStatus, "verified");
    } finally {
      database.close();
    }
  } finally {
    if (!fixtureClosed) await fixture.app.close();
    await fixture.bridge.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("a real running phased Auto-Cut run persists its processing writeback intent", async () => {
  const controlledContext = {
    documentLinks: ["https://guanghe.feishu.cn/docx/processing-writeback"],
    namingDisplayValue: "课程处理中",
    namingValueUnique: true,
    courseName: "课程处理中",
  };
  const fixture = await createFixture({
    controlledContext,
    // This lifecycle test exercises processing writeback, not the host's
    // Windows Management Instrumentation. Keep the course path deterministic.
    coursePathResolver: {
      classifyDrive: async () => "local",
      resolveMappedDrive: async () => { throw new Error("local roots do not resolve UNC mappings"); },
    },
  });
  try {
    const subject = await registerSubject(fixture, {
      delivery: {
        version: 1,
        rootPath: fixture.directory,
        courseNaming: { mode: "reuse_artifact_naming", fieldId: null },
        coursePathWriteback: { enabled: false, fieldId: null },
        writeback: {
          initial: { onProcessing: [{ fieldId: "fld_status", optionId: "opt_processing" }], onUploaded: [] },
          first_review: { onProcessing: [], onUploaded: [] },
          final_review: { onProcessing: [], onUploaded: [] },
        },
        finalDirectoryTrigger: { enabled: false, fieldId: null, optionId: null },
      },
    });
    const created = await jsonRequest(
      fixture.baseUrl,
      "/api/local/feishu/tasks",
      registration(subject, controlledContext),
    );
    assert.equal(created.response.status, 201, JSON.stringify(created.body));
    const started = await jsonRequest(fixture.baseUrl, `/api/tasks/${created.body.task.id}/start-ai`, {});
    assert.equal(started.response.status, 202, JSON.stringify(started.body));
    const run = await waitForRun(fixture.app, created.body.task.id);
    const deadline = Date.now() + 5_000;
    let outbox = null;
    while (Date.now() < deadline) {
      outbox = fixture.app.database.database.prepare(`
        SELECT state, payload_json FROM feishu_writeback_outbox WHERE run_id = ?
      `).get(run.runId);
      if (outbox) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.ok(outbox, "expected a processing writeback intent");
    assert.equal(JSON.parse(outbox.payload_json).optionId, "opt_processing");
    assert.deepEqual(
      fixture.app.database.database.prepare(`
        SELECT kind FROM feishu_delivery_facts WHERE run_id = ?
      `).all(run.runId).map((fact) => fact.kind),
      ["processing"],
    );
  } finally {
    await fixture.app.close();
    await fixture.bridge.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("a trusted phased Auto-Cut start persists an immutable run and injects private inputs", async () => {
  const controlledContext = {
    documentLinks: ["https://guanghe.feishu.cn/docx/lifecycle"],
    namingDisplayValue: "课程001",
    namingValueUnique: true,
  };
  const fixture = await createFixture({ controlledContext });
  try {
    const subject = await registerSubject(fixture);
    const created = await jsonRequest(fixture.baseUrl, "/api/local/feishu/tasks", registration(subject, {
      documentLinks: ["https://guanghe.feishu.cn/docx/registration-snapshot"],
      namingDisplayValue: "旧名称",
      namingValueUnique: true,
    }));
    assert.equal(created.response.status, 201, JSON.stringify(created.body));
    const started = await jsonRequest(fixture.baseUrl, `/api/tasks/${created.body.task.id}/start-ai`, {});
    assert.equal(started.response.status, 202, JSON.stringify(started.body));
    const run = await waitForRun(fixture.app, created.body.task.id);
    assert.equal(run.runId, started.body.run.id);
    assert.equal(run.taskId, created.body.task.id);
    assert.equal(run.subjectKey, SUBJECT_KEY);
    assert.equal(run.configVersion, subject.configVersion);
    assert.equal(run.stageId, "initial");
    assert.equal(run.eventId, "evt-lifecycle-1");
    assert.equal(run.state, "running");
    const manifest = JSON.parse(await readFile(run.manifestPath, "utf8"));
    assert.deepEqual(manifest.binding, {
      task_id: created.body.task.id,
      run_id: started.body.run.id,
      subject_key: SUBJECT_KEY,
      config_version: subject.configVersion,
      stage_id: "initial",
      event_id: "evt-lifecycle-1",
    });
    assert.equal(manifest.document.url, controlledContext.documentLinks[0]);
    assert.equal(run.artifactName, "课程001_初稿");
    const env = await waitForJsonFile(fixture.capturePath);
    assert.equal(env.CODEX_AUTOCUT_ARTIFACT_REPORT_URL.endsWith(
      `/api/local/tasks/${encodeURIComponent(created.body.task.id)}/runs/${encodeURIComponent(started.body.run.id)}/artifact-report`,
    ), true);
    assert.ok(env.CODEX_AUTOCUT_ARTIFACT_REPORT_TOKEN.length >= 32);
    assert.equal(env.CODEX_AUTOCUT_SOURCE_MANIFEST_PATH, run.manifestPath);
    assert.equal(env.CODEX_AUTOCUT_SOURCE_MANIFEST_SHA256, run.manifestSha256);
    assert.equal(env.CODEX_AUTOCUT_EXECUTION_INPUT_PATH, run.executionInputPath);
    assert.equal(env.CODEX_AUTOCUT_JOB_ROOT, path.dirname(run.manifestPath));
    assert.equal(env.CODEX_AUTOCUT_DRAFTS_ROOT, run.draftsRoot);
    assert.equal(env.CODEX_AUTOCUT_RESULT_PATH, run.resultPath);
    assert.equal(env.CODEX_AUTOCUT_PACKAGE_ZIP_PATH, run.packageZipPath);
    assert.equal(env.CODEX_AUTOCUT_TASK_ID, created.body.task.id);
    assert.equal(env.CODEX_AUTOCUT_RUN_ID, started.body.run.id);
    assert.equal(env.CODEX_AUTOCUT_SUBJECT_KEY, SUBJECT_KEY);
    assert.equal(env.CODEX_AUTOCUT_CONFIG_VERSION, String(subject.configVersion));
    assert.equal(env.CODEX_AUTOCUT_STAGE_ID, "initial");
    assert.equal(env.CODEX_AUTOCUT_EVENT_ID, "evt-lifecycle-1");
    assert.equal(env.CODEX_FEISHU_BRIDGE_SECRET, undefined);
    assert.deepEqual(fixture.bridge.requests, [{
      subjectKey: SUBJECT_KEY,
      configVersion: subject.configVersion,
      baseToken: "bas_lifecycle",
      tableId: "tbl_math",
      recordId: "rec_1",
    }]);
    await waitForTaskStatus(fixture.app, run.taskId, "blocked");
    const blockedRun = fixture.app.database.getFeishuAutoCutRun(run.runId);
    assert.equal(blockedRun.state, "blocked");
    assert.equal(blockedRun.errorCode, "autocut_result_missing");
    const attempts = await jsonRequest(
      fixture.baseUrl,
      `/api/local/tasks/${encodeURIComponent(run.taskId)}/autocut-runs`,
      undefined,
      { method: "GET" },
    );
    assert.equal(attempts.response.status, 200, JSON.stringify(attempts.body));
    assert.deepEqual(attempts.body.runs, [{
      runId: blockedRun.runId,
      taskId: blockedRun.taskId,
      threadId: started.body.thread.id,
      executionKind: "codex",
      failedPhase: null,
      lastPhase: null,
      attempt: blockedRun.attempt,
      subjectKey: blockedRun.subjectKey,
      configVersion: blockedRun.configVersion,
      stageId: blockedRun.stageId,
      eventId: blockedRun.eventId,
      manifestSha256: blockedRun.manifestSha256,
      artifactName: blockedRun.artifactName,
      state: blockedRun.state,
      errorCode: blockedRun.errorCode,
      errorMessage: blockedRun.errorMessage,
      createdAt: blockedRun.createdAt,
      updatedAt: blockedRun.updatedAt,
    }]);
    fixture.app.database.deleteAiChatRun(blockedRun.runId);
    const withoutAiRun = await jsonRequest(fixture.baseUrl,
      `/api/local/tasks/${encodeURIComponent(run.taskId)}/autocut-runs`, undefined, { method: "GET" });
    assert.equal(withoutAiRun.response.status, 200);
    assert.deepEqual(withoutAiRun.body.runs, [{
      ...attempts.body.runs[0], threadId: null, executionKind: null, failedPhase: null, lastPhase: null,
    }]);
  } finally {
    await fixture.app.close();
    await fixture.bridge.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("controlled-context preparation failure blocks and preserves the task and AI run", async () => {
  const fixture = await createFixture({ controlledContext: "document_link_missing", bridgeStatus: 409 });
  try {
    const subject = await registerSubject(fixture);
    const created = await jsonRequest(fixture.baseUrl, "/api/local/feishu/tasks", registration(subject, {
      documentLinks: ["https://guanghe.feishu.cn/docx/stale"],
      namingDisplayValue: "课程002",
      namingValueUnique: true,
    }));
    assert.equal(created.response.status, 201, JSON.stringify(created.body));
    const started = await jsonRequest(fixture.baseUrl, `/api/tasks/${created.body.task.id}/start-ai`, {});
    assert.equal(started.response.status, 409, JSON.stringify(started.body));
    const task = fixture.app.database.getTask(created.body.task.id);
    assert.equal(task.status, "blocked");
    const run = await waitForRun(fixture.app, task.id);
    assert.equal(run.state, "blocked");
    assert.equal(run.errorCode, "document_link_missing");
    const aiRuns = fixture.app.database.listAiChatRuns(task.threadId);
    assert.equal(aiRuns.length, 1);
    assert.equal(aiRuns[0].status, "failed");
    assert.equal(fixture.app.database.getFeishuExecution(task.id), null);
    await assert.rejects(() => readFile(fixture.capturePath, "utf8"), /ENOENT/);
  } finally {
    await fixture.app.close();
    await fixture.bridge.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

for (const hasCommonTarget of [true, false]) {
  test(`a phased report uploads to the frozen stage destination ${hasCommonTarget ? "with" : "without"} a common target`, async () => {
    const controlledContext = {
      documentLinks: ["https://guanghe.feishu.cn/docx/report-lifecycle"],
      namingDisplayValue: "课程003",
      namingValueUnique: true,
    };
    const fixture = await createFixture({
      controlledContext,
      turnDelayMs: 500,
      allowAutomaticExecution: true,
    });
    try {
      const subject = await registerSubject(fixture, {
        executionMode: "automatic",
        enqueueMode: "automatic",
        ...(hasCommonTarget ? {} : { targetPath: null, targetId: null }),
      });
      const created = await jsonRequest(
        fixture.baseUrl,
        "/api/local/feishu/tasks",
        registration(subject, controlledContext),
      );
      assert.equal(created.response.status, 201, JSON.stringify(created.body));
      const started = await jsonRequest(fixture.baseUrl, `/api/tasks/${created.body.task.id}/start-ai`, {});
      assert.equal(started.response.status, 202, JSON.stringify(started.body));
      const run = await waitForRun(fixture.app, created.body.task.id);
      const updated = await jsonRequest(fixture.baseUrl,
        `/api/local/feishu/workflow/subjects/${encodeURIComponent(SUBJECT_KEY)}`, {
          stages: { initial: { artifactTargetPath: path.join(fixture.directory, "new-stage-output") } },
        }, { method: "PATCH" });
      assert.equal(updated.response.status, 200, JSON.stringify(updated.body));
      const reenabled = await jsonRequest(fixture.baseUrl,
        `/api/local/feishu/workflow/subjects/${encodeURIComponent(SUBJECT_KEY)}/enable`, {
          expectedVersion: updated.body.subject.configVersion,
        });
      assert.equal(reenabled.response.status, 200, JSON.stringify(reenabled.body));
      const archiveSha256 = await writePassingRunResult(run);
      const reported = await reportRunArtifact(fixture, run, { sha256: archiveSha256 });
      assert.equal(reported.response.status, 201, JSON.stringify(reported.body));
      assert.equal(fixture.app.database.getFeishuAutoCutRun(run.runId).state, "reported");

      const completed = await waitForTaskStatus(fixture.app, run.taskId, "done");
      assert.equal(completed.status, "done");
      assert.equal(fixture.app.database.getFeishuAutoCutRun(run.runId).state, "completed");
      const [upload] = fixture.app.database.listTaskArtifactUploads(run.taskId);
      assert.ok(upload);
      const storedUpload = fixture.app.database.database.prepare(
        "SELECT target_path, target_id FROM artifact_uploads WHERE id = ?",
      ).get(upload.id);
      assert.equal(storedUpload.target_path, path.join(fixture.directory, "stage-output"));
      assert.equal(storedUpload.target_id, hasCommonTarget ? "target" : null);
    } finally {
      await fixture.app.close();
      await fixture.bridge.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });
}

test("a custom package ZIP directory is frozen and accepted independently of the subject's legacy source", async () => {
  const controlledContext = {
    documentLinks: ["https://guanghe.feishu.cn/docx/custom-zip-root"],
    namingDisplayValue: "自定义目录课程",
    namingValueUnique: true,
  };
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-custom-zip-source-"));
  const customRoot = path.join(directory, "custom-output");
  await mkdir(customRoot);
  const fixture = await createFixture({
    controlledContext,
    turnDelayMs: 500,
    packageZipSourceDirectory: customRoot,
    packageZipOutputMode: "custom",
  });
  try {
    const subject = await registerSubject(fixture);
    const created = await jsonRequest(fixture.baseUrl, "/api/local/feishu/tasks", registration(subject, controlledContext));
    assert.equal(created.response.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.task.feishuPackageSnapshot.zipOutputMode, "custom");
    const started = await jsonRequest(fixture.baseUrl, `/api/tasks/${created.body.task.id}/start-ai`, {});
    assert.equal(started.response.status, 202, JSON.stringify(started.body));
    const run = await waitForRun(fixture.app, created.body.task.id);
    // prepareFeishuRunInputs canonicalizes the configured root. Windows hosted
    // runners can expose their temporary directory through a junction, so
    // compare against the same canonical root instead of its input spelling.
    const relativePackageZipPath = path.relative(await realpath(customRoot), run.packageZipPath);
    assert.equal(
      path.isAbsolute(relativePackageZipPath)
        || relativePackageZipPath === ".."
        || relativePackageZipPath.startsWith(`..${path.sep}`),
      false,
    );
    await rm(fixture.zipSourceDirectory, { recursive: true, force: true });
    const archiveSha256 = await writePassingRunResult(run);
    const reported = await reportRunArtifact(fixture, run, { sha256: archiveSha256 });
    assert.equal(reported.response.status, 201, JSON.stringify(reported.body));
  } finally {
    await fixture.app.close();
    await fixture.bridge.close();
    await rm(fixture.directory, { recursive: true, force: true });
    await rm(directory, { recursive: true, force: true });
  }
});

test("a phased report rejects a result without the exact adjacent package receipt", async () => {
  const controlledContext = {
    documentLinks: ["https://guanghe.feishu.cn/docx/missing-package-receipt"],
    namingDisplayValue: "课程003A",
    namingValueUnique: true,
  };
  const fixture = await createFixture({ controlledContext, turnDelayMs: 1_000 });
  try {
    const subject = await registerSubject(fixture);
    const created = await jsonRequest(
      fixture.baseUrl,
      "/api/local/feishu/tasks",
      registration(subject, controlledContext),
    );
    const started = await jsonRequest(fixture.baseUrl, `/api/tasks/${created.body.task.id}/start-ai`, {});
    assert.equal(started.response.status, 202, JSON.stringify(started.body));
    const run = await waitForRun(fixture.app, created.body.task.id);
    const archiveSha256 = await writePassingRunResult(run, { includePackageReceipt: false });
    const reported = await reportRunArtifact(fixture, run, { sha256: archiveSha256 });
    assert.equal(reported.response.status, 409, JSON.stringify(reported.body));
    assert.equal(reported.body.error.code, "autocut_package_receipt_missing");
    assert.deepEqual(fixture.app.database.listTaskArtifacts(run.taskId), []);
  } finally {
    await fixture.app.close();
    await fixture.bridge.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("a phased report rejects a ZIP whose actual draft root differs from the frozen name", async () => {
  const controlledContext = {
    documentLinks: ["https://guanghe.feishu.cn/docx/wrong-zip-root"],
    namingDisplayValue: "课程003B",
    namingValueUnique: true,
  };
  const fixture = await createFixture({ controlledContext, turnDelayMs: 1_000 });
  try {
    const subject = await registerSubject(fixture);
    const created = await jsonRequest(
      fixture.baseUrl,
      "/api/local/feishu/tasks",
      registration(subject, controlledContext),
    );
    const started = await jsonRequest(fixture.baseUrl, `/api/tasks/${created.body.task.id}/start-ai`, {});
    assert.equal(started.response.status, 202, JSON.stringify(started.body));
    const run = await waitForRun(fixture.app, created.body.task.id);
    const archiveSha256 = await writePassingRunResult(run, { draftRoot: "另一个草稿" });
    const reported = await reportRunArtifact(fixture, run, { sha256: archiveSha256 });
    assert.equal(reported.response.status, 409, JSON.stringify(reported.body));
    assert.equal(reported.body.error.code, "AUTOCUT_RUN_BINDING_MISMATCH");
    assert.deepEqual(fixture.app.database.listTaskArtifacts(run.taskId), []);
  } finally {
    await fixture.app.close();
    await fixture.bridge.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("a phased report rejects every mismatched package receipt identity and validation field", async () => {
  const controlledContext = {
    documentLinks: ["https://guanghe.feishu.cn/docx/mismatched-package-receipt"],
    namingDisplayValue: "课程003C",
    namingValueUnique: true,
  };
  const fixture = await createFixture({ controlledContext, turnDelayMs: 5_000 });
  try {
    const subject = await registerSubject(fixture);
    const created = await jsonRequest(
      fixture.baseUrl,
      "/api/local/feishu/tasks",
      registration(subject, controlledContext),
    );
    const started = await jsonRequest(fixture.baseUrl, `/api/tasks/${created.body.task.id}/start-ai`, {});
    assert.equal(started.response.status, 202, JSON.stringify(started.body));
    const run = await waitForRun(fixture.app, created.body.task.id);
    const otherPath = path.join(path.dirname(run.packageZipPath), "other.zip");
    const cases = [
      ["binding", { binding: { ...runBinding(run), run_id: "other-run" } }, "AUTOCUT_RUN_BINDING_MISMATCH"],
      ["manifest", { source_manifest_sha256: "b".repeat(64) }, "AUTOCUT_RUN_BINDING_MISMATCH"],
      ["package path", { package_zip: otherPath }, "AUTOCUT_RUN_BINDING_MISMATCH"],
      ["archive path", { archive_path: otherPath }, "AUTOCUT_RUN_BINDING_MISMATCH"],
      ["archive hash", { archive_sha256: "b".repeat(64) }, "AUTOCUT_RUN_BINDING_MISMATCH"],
      ["draft name", { draft_name: "other-draft" }, "AUTOCUT_RUN_BINDING_MISMATCH"],
      ["package root", { package_root_name: "other-draft" }, "AUTOCUT_RUN_BINDING_MISMATCH"],
      ["workflow mode", { workflow_mode: "full" }, "autocut_package_receipt_invalid"],
      ["delivery mode", { delivery_mode: "native" }, "autocut_package_receipt_invalid"],
      ["CRC validation", { zip_crc_pass: false }, "autocut_package_receipt_invalid"],
      ["tree validation", { zip_tree_identity_pass: false }, "autocut_package_receipt_invalid"],
      ["source pairs", { source_pairs: null }, "autocut_package_receipt_invalid"],
    ];
    for (const [name, receiptOverrides, errorCode] of cases) {
      const archiveSha256 = await writePassingRunResult(run, { receiptOverrides });
      const reported = await reportRunArtifact(fixture, run, { sha256: archiveSha256 });
      assert.equal(reported.response.status, 409, `${name}: ${JSON.stringify(reported.body)}`);
      assert.equal(reported.body.error.code, errorCode, name);
      assert.deepEqual(fixture.app.database.listTaskArtifacts(run.taskId), [], name);
    }
  } finally {
    await fixture.app.close();
    await fixture.bridge.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("a phased report rejects result or report bindings that differ from the exact run", async () => {
  const controlledContext = {
    documentLinks: ["https://guanghe.feishu.cn/docx/mismatched-run-result"],
    namingDisplayValue: "课程003D",
    namingValueUnique: true,
  };
  const fixture = await createFixture({ controlledContext, turnDelayMs: 5_000 });
  try {
    const subject = await registerSubject(fixture);
    const created = await jsonRequest(
      fixture.baseUrl,
      "/api/local/feishu/tasks",
      registration(subject, controlledContext),
    );
    const started = await jsonRequest(fixture.baseUrl, `/api/tasks/${created.body.task.id}/start-ai`, {});
    assert.equal(started.response.status, 202, JSON.stringify(started.body));
    const run = await waitForRun(fixture.app, created.body.task.id);
    const otherPath = path.join(path.dirname(run.packageZipPath), "other.zip");
    const cases = [
      ["result binding", { resultOverrides: { binding: { ...runBinding(run), task_id: "other-task" } } }, {}],
      ["result manifest", { resultOverrides: { manifest_sha256: "b".repeat(64) } }, {}],
      ["result package path", { resultOverrides: { package_zip: otherPath } }, {}],
      ["result archive hash", { resultOverrides: { archive_sha256: "b".repeat(64) } }, {}],
      ["result draft name", { resultOverrides: { draft_name: "other-draft" } }, {}],
      ["reported manifest", {}, { manifestSha256: "b".repeat(64) }],
      ["reported ZIP path", {}, { path: otherPath }],
      ["reported archive hash", {}, { sha256: "b".repeat(64) }],
    ];
    for (const [name, resultOptions, reportOverrides] of cases) {
      const archiveSha256 = await writePassingRunResult(run, resultOptions);
      if (reportOverrides.path) {
        await writeFile(reportOverrides.path, await readFile(run.packageZipPath));
      }
      const reported = await reportRunArtifact(fixture, run, {
        sha256: archiveSha256,
        ...reportOverrides,
      });
      assert.equal(reported.response.status, 409, `${name}: ${JSON.stringify(reported.body)}`);
      assert.equal(reported.body.error.code, "AUTOCUT_RUN_BINDING_MISMATCH", name);
      assert.deepEqual(fixture.app.database.listTaskArtifacts(run.taskId), [], name);
    }
  } finally {
    await fixture.app.close();
    await fixture.bridge.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("a manual phased run enters review without automatically enqueueing its ZIP", async () => {
  const controlledContext = {
    documentLinks: ["https://guanghe.feishu.cn/docx/manual-lifecycle"],
    namingDisplayValue: "课程004",
    namingValueUnique: true,
  };
  const fixture = await createFixture({ controlledContext, turnDelayMs: 500 });
  try {
    const subject = await registerSubject(fixture, {
      executionMode: "manual",
      enqueueMode: "automatic",
    });
    const created = await jsonRequest(
      fixture.baseUrl,
      "/api/local/feishu/tasks",
      registration(subject, controlledContext),
    );
    assert.equal(created.response.status, 201, JSON.stringify(created.body));
    const started = await jsonRequest(fixture.baseUrl, `/api/tasks/${created.body.task.id}/start-ai`, {});
    assert.equal(started.response.status, 202, JSON.stringify(started.body));
    const run = await waitForRun(fixture.app, created.body.task.id);
    const archiveSha256 = await writePassingRunResult(run);
    const reported = await reportRunArtifact(fixture, run, { sha256: archiveSha256 });
    assert.equal(reported.response.status, 201, JSON.stringify(reported.body));

    const completed = await waitForTaskStatus(fixture.app, run.taskId, "in_review");
    assert.equal(completed.status, "in_review");
    assert.equal(fixture.app.database.getFeishuAutoCutRun(run.runId).state, "completed");
    assert.deepEqual(fixture.app.database.listTaskArtifactUploads(run.taskId), []);
  } finally {
    await fixture.app.close();
    await fixture.bridge.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("startup recovery revalidates phased terminal receipts before completing a claimed task", async () => {
  const controlledContext = {
    documentLinks: ["https://guanghe.feishu.cn/docx/startup-recovery"],
    namingDisplayValue: "课程004A",
    namingValueUnique: true,
  };
  const fixture = await createFixture({ controlledContext, turnDelayMs: 500 });
  let originalClosed = false;
  let restartedApp = null;
  try {
    const subject = await registerSubject(fixture);
    const created = await jsonRequest(
      fixture.baseUrl,
      "/api/local/feishu/tasks",
      registration(subject, controlledContext),
    );
    const started = await jsonRequest(fixture.baseUrl, `/api/tasks/${created.body.task.id}/start-ai`, {});
    assert.equal(started.response.status, 202, JSON.stringify(started.body));
    const run = await waitForRun(fixture.app, created.body.task.id);
    const archiveSha256 = await writePassingRunResult(run);
    const reported = await reportRunArtifact(fixture, run, { sha256: archiveSha256 });
    assert.equal(reported.response.status, 201, JSON.stringify(reported.body));
    await waitForTaskStatus(fixture.app, run.taskId, "in_review");
    const completedTask = fixture.app.database.getTask(run.taskId);

    await fixture.app.close();
    originalClosed = true;
    const database = new TaskboardDatabase(path.join(fixture.directory, "taskboard.sqlite"));
    try {
      const timestamp = new Date().toISOString();
      database.database.prepare(
        "UPDATE tasks SET status = 'in_progress', version = version + 1, updated_at = ? WHERE id = ?",
      ).run(timestamp, run.taskId);
      database.database.prepare("DELETE FROM task_completion_artifacts WHERE task_id = ?").run(run.taskId);
      database.database.prepare(
        "UPDATE feishu_autocut_runs SET state = 'reported', updated_at = ? WHERE run_id = ?",
      ).run(timestamp, run.runId);
      const activity = database.database.prepare(
        "SELECT MAX(rowid) AS rowid FROM task_activities WHERE task_id = ?",
      ).get(run.taskId);
      database.database.prepare(`
        INSERT INTO task_ai_starts
          (task_id, claim_token, thread_id, run_id, claimed_at, updated_at, claimed_activity_rowid)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        run.taskId,
        "startup-recovery-claim",
        completedTask.threadId,
        run.runId,
        timestamp,
        timestamp,
        activity.rowid,
      );
    } finally {
      database.close();
    }
    await writeFile(`${run.packageZipPath}.receipt.json`, "{invalid-json");

    restartedApp = createTaskboardServer({
      dataDirectory: fixture.directory,
      codexExecutable: process.execPath,
      feishuPackages: {
        packages: {
          "Auto-cut-lite": {
            alias: "Auto-cut-lite",
            name: "Auto-Cut Lite",
            projectId: "autocut-lite",
            workspacePath: fixture.workspacePath,
            zipSourceDirectory: fixture.zipSourceDirectory,
            prompt: "trusted package prompt",
            state: "enabled",
            revision: 1,
            maxConcurrent: 1,
          },
        },
      },
      feishuWorkflowSync: async () => ({ ok: true }),
    });
    const recovered = await waitForTaskStatus(restartedApp, run.taskId, "blocked", 1_000);
    assert.equal(recovered.status, "blocked");
    const recoveredRun = restartedApp.database.getFeishuAutoCutRun(run.runId);
    assert.equal(recoveredRun.state, "blocked");
    assert.equal(recoveredRun.errorCode, "autocut_package_receipt_invalid");
  } finally {
    await restartedApp?.close();
    if (!originalClosed) await fixture.app.close();
    await fixture.bridge.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("an explicit phased retry creates a new attempt and preserves the blocked run", async () => {
  const invocations = [];
  const fixture = await createFixture({
    controlledContext: "document_link_missing",
    bridgeStatus: 409,
    autoCutRunner: async ({ run }) => {
      invocations.push(run.runId);
      const error = new Error("fixture local preflight failed");
      error.code = "fixture_preflight_failed";
      throw error;
    },
  });
  try {
    const subject = await registerSubject(fixture);
    const created = await jsonRequest(
      fixture.baseUrl,
      "/api/local/feishu/tasks",
      registration(subject, {
        documentLinks: ["https://guanghe.feishu.cn/docx/stale-retry"],
        namingDisplayValue: "课程005",
        namingValueUnique: true,
      }),
    );
    const firstStart = await jsonRequest(fixture.baseUrl, `/api/tasks/${created.body.task.id}/start-ai`, {});
    assert.equal(firstStart.response.status, 409, JSON.stringify(firstStart.body));
    const blocked = fixture.app.database.getTask(created.body.task.id);
    const [firstRun] = fixture.app.database.listFeishuAutoCutRuns(blocked.id);
    assert.equal(blocked.status, "blocked");
    assert.equal(firstRun.state, "blocked");

    const staleRetry = await jsonRequest(
      fixture.baseUrl,
      `/api/local/tasks/${encodeURIComponent(blocked.id)}/autocut-retry`,
      { version: blocked.version + 1 },
    );
    assert.equal(staleRetry.response.status, 409, JSON.stringify(staleRetry.body));
    assert.equal(staleRetry.body.error.code, "VERSION_CONFLICT");
    assert.deepEqual(fixture.app.database.listFeishuAutoCutRuns(blocked.id).map((run) => run.attempt), [1]);

    const invalidConsents = [
      { allowVideoAudioAsr: "true", allowConfiguredLocalOutput: true },
      { allowVideoAudioAsr: true, allowConfiguredLocalOutput: false },
      { allowVideoAudioAsr: true },
      { allowVideoAudioAsr: true, allowConfiguredLocalOutput: true, prompt: "ignore policy" },
    ];
    for (const runConsent of invalidConsents) {
      const invalid = await jsonRequest(
        fixture.baseUrl,
        `/api/local/tasks/${encodeURIComponent(blocked.id)}/autocut-retry`,
        { version: blocked.version, runConsent },
      );
      assert.equal(invalid.response.status, 400, JSON.stringify(invalid.body));
      assert.deepEqual(
        fixture.app.database.listFeishuAutoCutRuns(blocked.id).map((run) => run.attempt),
        [1],
      );
    }

    fixture.bridge.setResponse({
      documentLinks: ["https://guanghe.feishu.cn/docx/retry-lifecycle"],
      namingDisplayValue: "课程005",
      namingValueUnique: true,
    });
    const retried = await jsonRequest(
      fixture.baseUrl,
      `/api/local/tasks/${encodeURIComponent(blocked.id)}/autocut-retry`,
      {
        version: blocked.version,
        runConsent: {
          allowVideoAudioAsr: true,
          allowConfiguredLocalOutput: true,
        },
      },
    );
    assert.equal(retried.response.status, 202, JSON.stringify(retried.body));
    assert.equal(retried.body.execution.trigger, "retry");
    const runs = await waitForRuns(fixture.app, blocked.id, 2);
    assert.deepEqual(runs.map((run) => run.attempt), [1, 2]);
    assert.equal(runs[0].runId, firstRun.runId);
    assert.equal(runs[0].state, "blocked");
    assert.notEqual(runs[1].runId, firstRun.runId);
    await waitForTaskStatus(fixture.app, blocked.id, "blocked");
    const failedRetry = fixture.app.database.getFeishuAutoCutRun(runs[1].runId);
    assert.deepEqual(invocations, [runs[1].runId]);
    assert.equal(failedRetry.state, "blocked");
    assert.equal(failedRetry.errorCode, "fixture_preflight_failed");
    assert.equal(failedRetry.errorMessage, "fixture local preflight failed");
    await assert.rejects(readFile(fixture.promptCapturePath, "utf8"), { code: "ENOENT" });
  } finally {
    await fixture.app.close();
    await fixture.bridge.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

const configRerunConsent = { allowVideoAudioAsr: true, allowConfiguredLocalOutput: true };

async function blockedConfigRerunFixture({ executionMode = "manual", ...options } = {}) {
  const fixture = await createFixture({ controlledContext: "document_link_missing", bridgeStatus: 409,
    autoCutRunner: async ({ run }) => { await writePassingRunResult(run); return { exitCode: 0 }; }, ...options });
  const subject = await registerSubject(fixture, { executionMode });
  const context = { documentLinks: ["https://guanghe.feishu.cn/docx/old"],
    namingDisplayValue: "旧课程", namingValueUnique: true };
  const envelope = registration(subject, context);
  const created = await jsonRequest(fixture.baseUrl, "/api/local/feishu/tasks", envelope);
  const start = await jsonRequest(fixture.baseUrl, `/api/tasks/${created.body.task.id}/start-ai`, {});
  assert.equal(start.response.status, 409, JSON.stringify(start.body));
  const task = fixture.app.database.getTask(created.body.task.id);
  assert.equal(task.status, "blocked");
  return { ...fixture, subject, task, envelope };
}

async function enableRepairedConfig(fixture, { executionMode = "manual", targetPath = undefined } = {}) {
  const route = `/api/local/feishu/workflow/subjects/${encodeURIComponent(SUBJECT_KEY)}`;
  const stages = structuredClone(fixture.subject.stages);
  stages.initial.videoSource.anchorText = "五、视频录制";
  if (targetPath) stages.initial.artifactTargetPath = targetPath;
  const saved = await jsonRequest(fixture.baseUrl, route, {
    stages,
    execution: { ...fixture.subject.execution, mode: executionMode },
  }, { method: "PATCH" });
  assert.equal(saved.response.status, 200, JSON.stringify(saved.body));
  const enabled = await jsonRequest(fixture.baseUrl, `${route}/enable`, {
    expectedVersion: saved.body.subject.configVersion,
  });
  assert.equal(enabled.response.status, 200, JSON.stringify(enabled.body));
  return enabled.body.subject;
}

test("configuration rerun uses the active anchor on the same card and preserves attempts and event deduplication", async () => {
  const f = await blockedConfigRerunFixture();
  let reopened;
  try {
    const [oldRun] = f.app.database.listFeishuAutoCutRuns(f.task.id);
    const oldOrigin = f.app.database.getFeishuTaskOrigin(f.task.id);
    const oldTargetPath = path.join(f.directory, "stage-output");
    const currentTargetPath = path.join(f.directory, "stage-output-current");
    const current = await enableRepairedConfig(f, { targetPath: currentTargetPath });
    f.bridge.setResponse({ documentLinks: ["https://guanghe.feishu.cn/docx/current"],
      namingDisplayValue: "新课程", namingValueUnique: true });
    const rerun = await jsonRequest(f.baseUrl, `/api/local/tasks/${f.task.id}/autocut-rerun-current`, {
      version: f.task.version, runConsent: configRerunConsent,
    });
    assert.equal(rerun.response.status, 202, JSON.stringify(rerun.body));
    const newTask = await waitForTaskStatus(f.app, rerun.body.task.id, "in_review");
    assert.equal(newTask.id, f.task.id);
    assert.equal(newTask.identifier, f.task.identifier);
    assert.equal(f.app.database.listFeishuTasks().length, 1);
    assert.equal(newTask.feishuOrigin.configVersion, current.configVersion);
    assert.equal(newTask.feishuOrigin.eventId, f.envelope.event.eventId, "keep the original real event identity");
    const newOrigin = f.app.database.getFeishuTaskOrigin(newTask.id);
    assert.equal(newOrigin.beforeOptionId, undefined, "a local rerun does not manufacture a status edge");
    assert.equal(newOrigin.eventOccurredAt, undefined);
    const [preservedRun, newRun] = f.app.database.listFeishuAutoCutRuns(newTask.id);
    assert.deepEqual(preservedRun, oldRun);
    assert.equal(newRun.attempt, 2);
    const manifest = JSON.parse(await readFile(newRun.manifestPath, "utf8"));
    assert.equal(manifest.sources.video.anchor_text, "五、视频录制");
    assert.match(JSON.stringify(manifest), /docx\/current/);
    assert.equal(newRun.configVersion, current.configVersion);
    assert.equal(f.app.database.getTaskArtifactForRun(newTask.id, newRun.runId).validationStatus, "verified");
    assert.equal(oldOrigin.configVersion, oldRun.configVersion);
    const replay = await jsonRequest(f.baseUrl, "/api/local/feishu/tasks", f.envelope);
    assert.equal(replay.response.status, 200, JSON.stringify(replay.body));
    assert.equal(replay.body.task.id, f.task.id);

    const actor = { type: "user", id: "local-user", name: "Local user", avatarUrl: null };
    f.app.database.database.prepare(`INSERT INTO task_artifacts (
      id, task_id, run_id, storage_key, filename, content_type, size, sha256,
      source_mode, validation_status, entry_count, draft_root, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'driver_report', 'verified', 2, 'draft', ?, ?)`)
      .run("historical-config-artifact", newTask.id, oldRun.runId, "historical-config-artifact.zip",
        "historical.zip", "application/zip", 10, "a".repeat(64), newTask.createdAt, newTask.updatedAt);
    const historicalArtifact = f.app.database.getTaskArtifactForRun(newTask.id, oldRun.runId);
    assert.ok(historicalArtifact);
    f.app.database.updateTask(newTask.id, newTask.version, { status: "done" }, null, null, actor);
    const historicalUpload = await jsonRequest(f.baseUrl, `/api/local/tasks/${newTask.id}/upload-queue`, {
      artifactId: historicalArtifact.id,
    });
    assert.equal(historicalUpload.response.status, 202, JSON.stringify(historicalUpload.body));
    assert.equal(f.app.database.database.prepare("SELECT target_path FROM artifact_uploads WHERE id = ?")
      .get(historicalUpload.body.upload.id).target_path, oldTargetPath);
    const currentUpload = await jsonRequest(f.baseUrl, `/api/local/tasks/${newTask.id}/upload-queue`, {
      artifactId: f.app.database.getTaskArtifactForRun(newTask.id, newRun.runId).id,
    });
    assert.equal(currentUpload.response.status, 202, JSON.stringify(currentUpload.body));
    assert.equal(f.app.database.database.prepare("SELECT target_path FROM artifact_uploads WHERE id = ?")
      .get(currentUpload.body.upload.id).target_path, currentTargetPath);

    const repeat = await jsonRequest(f.baseUrl, `/api/local/tasks/${f.task.id}/autocut-rerun-current`, {
      version: f.task.version, runConsent: configRerunConsent,
    });
    assert.equal(repeat.response.status, 409, JSON.stringify(repeat.body));
    assert.equal(f.app.database.listFeishuAutoCutRuns(newTask.id).length, 2);
    // Opening the same database must not migrate the derived origin into the
    // unique real-event reservation or make the completed run execute again.
    await f.app.close();
    reopened = createTaskboardServer(f.serverOptions);
    const address = await listenTaskboardOnFetchSafePort(reopened);
    assert.equal(reopened.database.findFeishuTaskByEventId(f.envelope.event.eventId).id, f.task.id);
    const afterRestart = await jsonRequest(`http://127.0.0.1:${address.port}`,
      `/api/local/tasks/${f.task.id}/autocut-rerun-current`, { version: f.task.version, runConsent: configRerunConsent });
    assert.equal(afterRestart.response.status, 409, JSON.stringify(afterRestart.body));
    assert.deepEqual(reopened.database.listFeishuAutoCutRuns(newTask.id), [oldRun, newRun]);
    const archived = reopened.database.archiveTask(newTask.id, reopened.database.getTask(newTask.id).version, null, null,
      { type: "user", id: "local-user", name: "Local user", avatarUrl: null });
    reopened.database.deleteArchivedTask(newTask.id, archived.version);
    assert.throws(() => reopened.database.assertFeishuEventNotDeleted({
      source: "feishu-base", ...f.envelope.event, ...f.envelope.binding, controlledContext: f.envelope.controlledContext,
    }, { registration: true }), { code: "FEISHU_TASK_DELETED" });
  } finally {
    await (reopened ?? f.app).close();
    await f.bridge.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("replaying the original automatic event preserves a queued same-card rerun reservation", async () => {
  let releaseFirstRunner;
  let firstRunnerStarted;
  const firstStarted = new Promise(resolve => { firstRunnerStarted = resolve; });
  const firstRunnerGate = new Promise(resolve => { releaseFirstRunner = resolve; });
  let invocations = 0;
  const runner = async ({ run }) => {
    if (++invocations === 1) {
      firstRunnerStarted();
      await firstRunnerGate;
    }
    await writePassingRunResult(run);
    return { exitCode: 0 };
  };
  const f = await blockedConfigRerunFixture({ allowAutomaticExecution: true, autoCutRunner: runner });
  try {
    const current = await enableRepairedConfig(f, { executionMode: "automatic" });
    const context = { documentLinks: ["https://guanghe.feishu.cn/docx/current"],
      namingDisplayValue: "新课程", namingValueUnique: true };
    f.bridge.setResponse(context);
    const blockerEnvelope = registration(current, context, { eventId: "evt-rerun-slot-blocker" });
    blockerEnvelope.event.recordId = "rec_slot_blocker";
    const blocker = await jsonRequest(f.baseUrl, "/api/local/feishu/tasks", blockerEnvelope);
    assert.equal(blocker.response.status, 201, JSON.stringify(blocker.body));
    let blockerTimeout;
    try {
      await Promise.race([
        firstStarted,
        new Promise((_, reject) => { blockerTimeout = setTimeout(() => reject(new Error("Timed out waiting for the slot blocker")), 9_000); }),
      ]);
    } finally {
      clearTimeout(blockerTimeout);
    }

    const rerun = await jsonRequest(f.baseUrl, `/api/local/tasks/${f.task.id}/autocut-rerun-current`, {
      version: f.task.version, runConsent: configRerunConsent,
    });
    assert.equal(rerun.response.status, 202, JSON.stringify(rerun.body));
    assert.equal(rerun.body.execution.state, "queued");
    const reservedExecution = f.app.database.getFeishuExecution(f.task.id);
    assert.equal(f.app.database.getTask(f.task.id).status, "queued");

    const replay = await jsonRequest(f.baseUrl, "/api/local/feishu/tasks", f.envelope);
    assert.equal(replay.response.status, 200, JSON.stringify(replay.body));
    assert.equal(replay.body.task.id, f.task.id);
    assert.deepEqual(f.app.database.getFeishuExecution(f.task.id), reservedExecution);
    assert.equal(f.app.database.getTask(f.task.id).status, "queued");

    releaseFirstRunner();
    await waitForRuns(f.app, f.task.id, 2);
    await waitForTaskStatus(f.app, f.task.id, "done");
    assert.equal(invocations, 2);
    assert.equal(f.app.database.listFeishuTasks().length, 2);
  } finally {
    releaseFirstRunner?.();
    await f.app.close(); await f.bridge.close(); await rm(f.directory, { recursive: true, force: true });
  }
});

test("configuration rerun rejects missing consent, stale versions, copied markers and simulated sources without creating tasks", async () => {
  const f = await blockedConfigRerunFixture();
  try {
    const request = (task, body) => jsonRequest(f.baseUrl, `/api/local/tasks/${task.id}/autocut-rerun-current`, body);
    const noConsent = await request(f.task, { version: f.task.version });
    assert.equal(noConsent.response.status, 400);
    const stale = await request(f.task, { version: f.task.version + 1, runConsent: configRerunConsent });
    assert.equal(stale.body.error.code, "VERSION_CONFLICT");
    const actor = { type: "user", id: "local-user", name: "本地用户", avatarUrl: null };
    const copied = f.app.database.createTask({ projectId: f.task.projectId, title: "copied",
      description: f.task.description, status: "blocked", priority: "none", labels: ["feishu"],
      actor, assignee: actor, startDate: null, dueDate: null });
    const forged = await request(copied, { version: copied.version, runConsent: configRerunConsent });
    assert.equal(forged.body.error.code, "TASK_NOT_STARTABLE");
    const simulation = await jsonRequest(f.baseUrl, "/api/local/feishu/tasks", {
      ...f.envelope, event: { ...f.envelope.event, eventId: "simulation-config-rerun", deliverySource: "simulation" },
    });
    const simulated = await request(simulation.body.task, { version: simulation.body.task.version, runConsent: configRerunConsent });
    assert.equal(simulated.body.error.code, "AUTOCUT_RERUN_NOT_ALLOWED");
    assert.equal(f.app.database.listFeishuTasks().length, 2);
  } finally {
    await f.app.close(); await f.bridge.close(); await rm(f.directory, { recursive: true, force: true });
  }
});

test("configuration rerun rechecks the parent and active version after reading current record values", async () => {
  const f = await blockedConfigRerunFixture();
  let release;
  try {
    const current = await enableRepairedConfig(f);
    f.bridge.setResponse({ documentLinks: ["https://guanghe.feishu.cn/docx/current"],
      namingDisplayValue: "新课程", namingValueUnique: true });
    const gate = new Promise(resolve => { release = resolve; });
    f.bridge.holdResponses(gate);
    const reads = f.bridge.requests.length;
    const pending = jsonRequest(f.baseUrl, `/api/local/tasks/${f.task.id}/autocut-rerun-current`, {
      version: f.task.version, runConsent: configRerunConsent,
    });
    const deadline = Date.now() + 2000;
    while (f.bridge.requests.length === reads && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(f.bridge.requests.length > reads);
    const route = `/api/local/feishu/workflow/subjects/${encodeURIComponent(SUBJECT_KEY)}`;
    const disabled = await jsonRequest(f.baseUrl, `${route}/disable`, { expectedVersion: current.configVersion });
    assert.equal(disabled.response.status, 200, JSON.stringify(disabled.body));
    release();
    const result = await pending;
    assert.equal(result.response.status, 409, JSON.stringify(result.body));
    assert.equal(f.app.database.listFeishuTasks().length, 1);
    assert.deepEqual(f.app.database.getTask(f.task.id), f.task);
  } finally {
    release?.(); await f.app.close(); await f.bridge.close(); await rm(f.directory, { recursive: true, force: true });
  }
});

test("configuration rerun rejects concurrent stale clicks before a single local execution", async () => {
  const f = await blockedConfigRerunFixture();
  let release;
  try {
    await enableRepairedConfig(f);
    f.bridge.setResponse({ documentLinks: ["https://guanghe.feishu.cn/docx/current"],
      namingDisplayValue: "新课程", namingValueUnique: true });
    f.bridge.holdResponses(new Promise(resolve => { release = resolve; }));
    const reads = f.bridge.requests.length;
    const send = () => jsonRequest(f.baseUrl, `/api/local/tasks/${f.task.id}/autocut-rerun-current`, {
      version: f.task.version, runConsent: configRerunConsent,
    });
    const pending = [send(), send()];
    const deadline = Date.now() + 2000;
    while (f.bridge.requests.length < reads + 2 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(f.bridge.requests.length, reads + 2);
    release();
    const responses = await Promise.all(pending);
    assert.equal(responses.filter(r => r.response.status === 202).length, 1);
    assert.equal(responses.filter(r => r.response.status === 409).length, 1);
    await waitForTaskStatus(f.app, f.task.id, "in_review");
    assert.equal(f.app.database.listFeishuTasks().length, 1);
    assert.equal(f.app.database.listFeishuAutoCutRuns(f.task.id).length, 2);
  } finally {
    release?.(); await f.app.close(); await f.bridge.close(); await rm(f.directory, { recursive: true, force: true });
  }
});

test("configuration rerun failure rejects an unconsented retry without changing its task or attempts", async () => {
  let invocations = 0;
  const f = await blockedConfigRerunFixture({ autoCutRunner: async ({ run }) => {
    if (++invocations === 1) throw Object.assign(new Error("fixture failure"), { code: "fixture_failed" });
    await writePassingRunResult(run); return { exitCode: 0 };
  } });
  try {
    await enableRepairedConfig(f);
    f.bridge.setResponse({ documentLinks: ["https://guanghe.feishu.cn/docx/current"],
      namingDisplayValue: "新课程", namingValueUnique: true });
    const created = await jsonRequest(f.baseUrl, `/api/local/tasks/${f.task.id}/autocut-rerun-current`, {
      version: f.task.version, runConsent: configRerunConsent,
    });
    assert.equal(created.response.status, 202, JSON.stringify(created.body));
    const blocked = await waitForTaskStatus(f.app, created.body.task.id, "blocked");
    const oldRuns = f.app.database.listFeishuAutoCutRuns(blocked.id);
    const rejected = await jsonRequest(f.baseUrl, `/api/local/tasks/${blocked.id}/autocut-rerun-current`, { version: blocked.version });
    assert.equal(rejected.response.status, 400, JSON.stringify(rejected.body));
    assert.deepEqual(f.app.database.getTask(blocked.id), blocked);
    assert.deepEqual(f.app.database.listFeishuAutoCutRuns(blocked.id), oldRuns);
    const retry = await jsonRequest(f.baseUrl, `/api/local/tasks/${blocked.id}/autocut-rerun-current`, {
      version: blocked.version, runConsent: configRerunConsent,
    });
    assert.equal(retry.response.status, 202, JSON.stringify(retry.body));
    await waitForTaskStatus(f.app, blocked.id, "in_review");
    assert.equal(invocations, 2);
    assert.equal(f.app.database.listFeishuTasks().length, 1);
    assert.equal(f.app.database.listFeishuAutoCutRuns(blocked.id).length, 3);
  } finally {
    await f.app.close(); await f.bridge.close(); await rm(f.directory, { recursive: true, force: true });
  }
});

test("Auto-Cut retry rejects non-blocked, copied-marker, and legacy tasks", async () => {
  const controlledContext = {
    documentLinks: ["https://guanghe.feishu.cn/docx/retry-eligibility"],
    namingDisplayValue: "课程006",
    namingValueUnique: true,
  };
  const fixture = await createFixture({ controlledContext });
  try {
    const subject = await registerSubject(fixture);
    const phased = await jsonRequest(
      fixture.baseUrl,
      "/api/local/feishu/tasks",
      registration(subject, controlledContext),
    );
    assert.equal(phased.response.status, 201, JSON.stringify(phased.body));
    const nonBlocked = await jsonRequest(
      fixture.baseUrl,
      `/api/local/tasks/${encodeURIComponent(phased.body.task.id)}/autocut-retry`,
      {
        version: phased.body.task.version,
        runConsent: {
          allowVideoAudioAsr: true,
          allowConfiguredLocalOutput: true,
        },
      },
    );
    assert.equal(nonBlocked.response.status, 409, JSON.stringify(nonBlocked.body));
    assert.equal(nonBlocked.body.error.code, "AUTOCUT_RETRY_NOT_ALLOWED");

    const actor = { type: "user", id: "local-user", name: "本地用户", avatarUrl: null };
    const copiedMarker = fixture.app.database.createTask({
      projectId: subject.projectId,
      title: "Copied marker",
      description: phased.body.task.description,
      status: "blocked",
      priority: "none",
      labels: ["feishu"],
      actor,
      assignee: actor,
      startDate: null,
      dueDate: null,
    });
    const forged = await jsonRequest(
      fixture.baseUrl,
      `/api/local/tasks/${encodeURIComponent(copiedMarker.id)}/autocut-retry`,
      {
        version: copiedMarker.version,
        runConsent: {
          allowVideoAudioAsr: true,
          allowConfiguredLocalOutput: true,
        },
      },
    );
    assert.equal(forged.response.status, 409, JSON.stringify(forged.body));
    assert.equal(forged.body.error.code, "TASK_NOT_STARTABLE");

    const legacyOrigin = {
      version: 1,
      source: "feishu-base",
      eventId: "evt-legacy-retry",
      baseToken: "bas_lifecycle",
      tableId: "tbl_math",
      subjectKey: SUBJECT_KEY,
      recordId: "rec_legacy_retry",
      triggerField: "流程",
      triggerValue: "待剪辑",
      mode: "manual",
      executionMode: "manual",
      packageAlias: "Auto-cut-lite",
    };
    const legacy = await jsonRequest(fixture.baseUrl, "/api/local/feishu/tasks", {
      projectId: subject.projectId,
      title: "Legacy Auto-Cut",
      description: feishuDescription(legacyOrigin),
      status: "blocked",
      priority: "none",
      labels: ["feishu"],
    });
    assert.equal(legacy.response.status, 201, JSON.stringify(legacy.body));
    const legacyRetry = await jsonRequest(
      fixture.baseUrl,
      `/api/local/tasks/${encodeURIComponent(legacy.body.task.id)}/autocut-retry`,
      {
        version: legacy.body.task.version,
        runConsent: {
          allowVideoAudioAsr: true,
          allowConfiguredLocalOutput: true,
        },
      },
    );
    assert.equal(legacyRetry.response.status, 409, JSON.stringify(legacyRetry.body));
    assert.equal(legacyRetry.body.error.code, "AUTOCUT_RETRY_NOT_ALLOWED");
  } finally {
    await fixture.app.close();
    await fixture.bridge.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});
