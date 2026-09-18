import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";

import { createTaskboardServer } from "../server/index.mjs";
import { createFeishuDeliveryStore } from "../server/feishu-delivery-store.mjs";

const SECRET = "writeback-app-fixture-secret";
const actor = { type: "user", id: "tester", name: "Tester", avatarUrl: null };
const ZIP_BYTES = Buffer.from("verified zip bytes", "utf8");

async function waitFor(predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = predicate();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for the writeback worker");
}

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-writeback-app-"));
  const requests = [];
  const bridge = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    requests.push({
      method: request.method,
      pathname: new URL(request.url, "http://127.0.0.1").pathname,
      headers: request.headers,
      body: JSON.parse(body),
    });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ writeback: { outcome: "updated" } }));
  });
  await new Promise((resolve) => bridge.listen(0, "127.0.0.1", resolve));
  const bridgeUrl = `http://127.0.0.1:${bridge.address().port}`;
  const app = createTaskboardServer({
    dataDirectory: directory,
    codexExecutable: process.execPath,
    feishuBridgeUrl: bridgeUrl,
    feishuBridgeSecret: SECRET,
    artifactService: { createDownloadStream: () => Readable.from([ZIP_BYTES]) },
  });
  const project = app.database.createProject({ id: "writeback-project", name: "Writeback", workspacePath: null });
  const task = app.database.createTask({
    id: "task-001",
    projectId: project.id,
    title: "Writeback task",
    description: "",
    status: "todo",
    priority: "none",
    labels: ["feishu"],
    actor,
    assignee: actor,
    startDate: null,
    dueDate: null,
    feishuOrigin: {
      source: "feishu-base",
      eventId: "event-001",
      baseToken: "bas_writeback",
      tableId: "tbl_courses",
      recordId: "rec-001",
      subjectKey: "bas_writeback:tbl_courses",
      configVersion: 1,
      stageId: "initial",
    },
  });
  const run = app.database.createFeishuAutoCutRun({
    runId: "run-001",
    taskId: task.id,
    subjectKey: "bas_writeback:tbl_courses",
    configVersion: 1,
    stageId: "initial",
    eventId: "event-001",
    resultPath: path.join(directory, "result.json"),
  });
  const store = createFeishuDeliveryStore({ database: app.database });
  const intent = store.enqueueWritebackIntent({
    idempotencyKey: "run-001:processing:0",
    taskId: task.id,
    runId: run.runId,
    courseBindingId: null,
    operation: { type: "single_select", fieldId: "fld_status", optionId: "opt_processing" },
  });
  return {
    app,
    bridge,
    requests,
    store,
    intent,
    directory,
    async close() {
      await app.close();
      await new Promise((resolve) => bridge.close(resolve));
      await rm(directory, { recursive: true, force: true });
    },
  };
}

function metadataMarker(origin) {
  const metadata = {
    version: origin.version,
    source: origin.source,
    eventId: origin.eventId,
    baseToken: origin.baseToken,
    tableId: origin.tableId,
    recordId: origin.recordId,
    triggerField: origin.triggerField,
    triggerFieldId: origin.triggerFieldId,
    triggerValue: origin.triggerValue,
    statusFieldId: origin.statusFieldId,
    beforeOptionId: origin.beforeOptionId,
    afterOptionId: origin.afterOptionId,
    stageId: origin.stageId,
    mode: origin.mode,
    executionMode: origin.executionMode,
    subjectKey: origin.subjectKey,
    configVersion: origin.configVersion,
    uploadMode: origin.uploadMode,
    packageAlias: origin.packageAlias,
    packageSource: origin.packageSource,
    concurrencyGroup: origin.concurrencyGroup,
    maxConcurrent: origin.maxConcurrent,
    resourceGroups: origin.resourceGroups,
  };
  return `<!-- feishu-codex-task:v1:${Buffer.from(JSON.stringify(metadata), "utf8").toString("base64url")} -->`;
}

async function persistPublishedDelivery(f) {
  const timestamp = new Date().toISOString();
  const subjectKey = "bas_delivery:tbl_courses";
  const courseName = "Course 001";
  const rootPath = path.join(f.directory, "delivery-root");
  const targetPath = path.join(rootPath, courseName, "01初稿");
  await mkdir(rootPath, { recursive: true });
  f.app.database.database.prepare(`
    INSERT INTO feishu_bases (
      base_token, base_name, source_url_label, metadata_refreshed_at, created_at, updated_at
    ) VALUES (?, ?, NULL, NULL, ?, ?)
  `).run("bas_delivery", "Delivery Base", timestamp, timestamp);
  f.app.database.database.prepare(`
    INSERT INTO feishu_subjects (
      subject_key, base_token, table_id, table_name, project_id, display_enabled,
      lifecycle, config_version, config_json, metadata_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 1, 'enabled', 1, '{}', '{}', ?, ?)
  `).run(subjectKey, "bas_delivery", "tbl_courses", "Courses", "writeback-project", timestamp, timestamp);
  f.app.database.database.prepare(`
    INSERT INTO feishu_subject_versions (
      subject_key, version, snapshot_json, lifecycle, enabled_at, closed_at, created_at
    ) VALUES (?, 1, ?, 'enabled', NULL, NULL, ?)
  `).run(subjectKey, JSON.stringify({
    baseToken: "bas_delivery",
    tableId: "tbl_courses",
    delivery: {
      version: 1,
      coursePathWriteback: { enabled: true, fieldId: "fld_course_path" },
      writeback: {
        initial: { onProcessing: [], onUploaded: [{ fieldId: "fld_status", optionId: "opt_uploaded" }] },
        first_review: { onProcessing: [], onUploaded: [] },
        final_review: { onProcessing: [], onUploaded: [] },
      },
    },
  }), timestamp);
  const origin = {
    version: 1,
    source: "feishu-base",
    eventId: "event-delivery-001",
    baseToken: "bas_delivery",
    tableId: "tbl_courses",
    recordId: "rec-delivery-001",
    triggerField: "流程",
    triggerFieldId: "fld_stage",
    triggerValue: "初稿",
    statusFieldId: "fld_stage",
    beforeOptionId: "opt_other",
    afterOptionId: "opt_initial",
    stageId: "initial",
    mode: "manual",
    executionMode: "manual",
    subjectKey,
    configVersion: 1,
    uploadMode: "manual",
    packageAlias: "Auto-cut-lite",
    packageSource: "subject-config",
    concurrencyGroup: "autocut:Auto-cut-lite",
    maxConcurrent: 1,
    resourceGroups: [],
    stageSnapshot: { artifactTargetPath: targetPath },
    controlledContext: {
      documentLinks: [],
      namingDisplayValue: courseName,
      namingValueUnique: true,
      courseName,
    },
  };
  const task = f.app.database.createTask({
    id: "task-delivery-001",
    projectId: "writeback-project",
    title: "Delivery ZIP",
    description: metadataMarker(origin),
    status: "done",
    priority: "none",
    labels: ["feishu"],
    actor,
    assignee: actor,
    startDate: null,
    dueDate: null,
    feishuOrigin: origin,
  });
  const run = f.app.database.createFeishuAutoCutRun({
    runId: "run-delivery-001",
    taskId: task.id,
    subjectKey,
    configVersion: 1,
    stageId: "initial",
    eventId: origin.eventId,
    resultPath: path.join(f.directory, "delivery-result.json"),
  });
  const binding = f.store.ensureCourseBinding({
    identity: { baseToken: origin.baseToken, tableId: origin.tableId, recordId: origin.recordId },
    subjectVersion: 1,
    namingValue: courseName,
    resolvedPaths: {
      actualRoot: rootPath,
      coursePath: path.join(rootPath, courseName),
      displayPath: `delivery-root\\${courseName}`,
      pathKind: "local",
      canonicalLocationKey: path.join(rootPath, courseName),
    },
    trustedEventId: origin.eventId,
  });
  const sha256 = createHash("sha256").update(ZIP_BYTES).digest("hex");
  f.app.database.database.prepare(`
    INSERT INTO task_artifacts (
      id, task_id, run_id, storage_key, filename, content_type, size, sha256,
      source_mode, validation_status, entry_count, draft_root, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'application/zip', ?, ?, 'driver_report', 'verified', 1, 'draft', ?, ?)
  `).run("artifact-delivery-001", task.id, run.runId, "storage-delivery-001", "Course 001_初稿.zip", ZIP_BYTES.length, sha256, timestamp, timestamp);
  const upload = f.app.database.createArtifactUpload({
    taskId: task.id,
    artifactId: "artifact-delivery-001",
    subjectKey,
    storageKey: "storage-delivery-001",
    targetId: "delivery-target",
    targetPath,
    publicationRootPath: rootPath,
    courseBindingId: binding.bindingId,
    runId: run.runId,
    filename: "Course 001_初稿.zip",
    sha256,
    uploadConcurrency: 1,
  });
  const claimed = f.app.database.claimNextArtifactUpload();
  f.app.database.markArtifactUploadUploaded(claimed.id, claimed.claimToken, null, {
    publication: { destination: path.join(targetPath, "Course 001_初稿.zip"), sha256, created: true },
  });
  return { binding, run, upload };
}

test("starts the writeback worker and sends only an authenticated opaque claim to the loopback Bridge", async () => {
  const f = await fixture();
  try {
    await f.app.listen({ host: "127.0.0.1", port: 0 });
    const completed = await waitFor(() => {
      const value = f.store.getWritebackIntent(f.intent.id);
      return value?.state === "succeeded" ? value : null;
    });

    assert.equal(completed.state, "succeeded");
    assert.deepEqual(f.requests.map((request) => ({
      method: request.method,
      pathname: request.pathname,
      client: request.headers["x-feishu-bridge-client"],
      secret: request.headers["x-feishu-bridge-secret"],
      body: request.body,
    })), [{
      method: "POST",
      pathname: "/api/feishu/workflow/writeback",
      client: "taskboard",
      secret: SECRET,
      body: {
        operationId: f.intent.id,
        claimToken: f.requests[0].body.claimToken,
        version: 2,
      },
    }]);
  } finally {
    await f.close();
  }
});

test("reconciles a persisted ZIP publication into its stage and first-course writebacks at startup", async () => {
  const f = await fixture();
  try {
    const { binding, run } = await persistPublishedDelivery(f);
    await f.app.listen({ host: "127.0.0.1", port: 0 });
    await waitFor(() => {
      const rows = f.app.database.database.prepare(`
        SELECT idempotency_key, state FROM feishu_writeback_outbox
        WHERE idempotency_key IN (?, ?)
        ORDER BY idempotency_key
      `).all(`course-path:${binding.bindingId}`, `${run.runId}:stage-uploaded:0`);
      return rows.length === 2 && rows.every((row) => row.state === "succeeded") ? rows : null;
    });

    const rows = f.app.database.database.prepare(`
      SELECT idempotency_key, payload_json FROM feishu_writeback_outbox
      WHERE idempotency_key IN (?, ?)
      ORDER BY idempotency_key
    `).all(`course-path:${binding.bindingId}`, `${run.runId}:stage-uploaded:0`);
    assert.deepEqual(rows.map((row) => ({
      idempotencyKey: row.idempotency_key,
      operation: JSON.parse(row.payload_json),
    })), [
      {
        idempotencyKey: `course-path:${binding.bindingId}`,
        operation: { type: "text", fieldId: "fld_course_path", value: "delivery-root\\Course 001" },
      },
      {
        idempotencyKey: `${run.runId}:stage-uploaded:0`,
        operation: { type: "single_select", fieldId: "fld_status", optionId: "opt_uploaded" },
      },
    ]);
  } finally {
    await f.close();
  }
});
