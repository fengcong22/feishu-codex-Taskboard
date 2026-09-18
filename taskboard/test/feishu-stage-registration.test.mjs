import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, rm } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { createTaskboardServer } from "../server/index.mjs";
import { subjectProjectId } from "../server/feishu-workflow-store.mjs";
import { createBridge } from "../../src/bridge.mjs";
import { JsonStateStore } from "../../src/state-store.mjs";
import { TaskboardClient } from "../../src/taskboard-client.mjs";

const SECRET = "fixture-stage-registration-secret";
const SUBJECT_KEY = "bas_stage:tbl_math";

function stage(stageId, optionId, value) {
  return {
    enabled: true,
    trigger: { fieldId: "fld_status", optionId, value },
    videoSource: { kind: "docx_section", anchorText: "录屏" },
    reviewSource: { kind: "docx_section", anchorText: "修改意见" },
    audio: { mode: "video_original" },
    artifactTargetPath: `C:\\approved\\${stageId}`,
    nameSuffix: `_${value}`,
  };
}

async function fixture({
  allowAutomaticExecution = false,
  packageResourceGroups = [],
  coursePathResolver = null,
  feishuBridgeUrl = undefined,
  feishuWorkflowSync = async () => ({ ok: true }),
  uploadWorker = undefined,
} = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-stage-registration-"));
  const workspace = path.join(directory, "workspace");
  const zipSourceDirectory = path.join(directory, "zips");
  await mkdir(workspace);
  await mkdir(zipSourceDirectory);
  const app = createTaskboardServer({
    dataDirectory: directory,
    codexExecutable: process.execPath,
    feishuBridgeSecret: SECRET,
    allowAutomaticExecution,
    feishuWorkflowSync,
    ...(feishuBridgeUrl ? { feishuBridgeUrl } : {}),
    ...(coursePathResolver ? { coursePathResolver } : {}),
    ...(uploadWorker ? { uploadWorker } : {}),
    feishuPackages: {
      packages: {
        "Auto-cut-lite": {
          name: "Auto-Cut Lite",
          projectId: "autocut-lite",
          workspacePath: workspace,
          zipSourceDirectory,
          prompt: "trusted package prompt",
          resourceGroups: packageResourceGroups,
          state: "enabled",
        },
      },
    },
  });
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  const baseUrl = `http://127.0.0.1:${address.port}`;
  return { app, baseUrl, directory, workspace, zipSourceDirectory };
}

async function request(baseUrl, pathname, body, headers = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-taskboard-client": "feishu-bridge",
      "x-feishu-bridge-secret": SECRET,
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { response, body: text ? JSON.parse(text) : undefined };
}

async function enableSubject(fixtureData, { subjectResourceGroups = [], delivery = undefined } = {}) {
  const catalog = await request(fixtureData.baseUrl, "/api/local/feishu/workflow/catalog", {
    baseToken: "bas_stage",
    baseName: "阶段 Base",
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
            { id: "opt_review", name: "初审修改" },
            { id: "opt_final", name: "终审修改" },
          ],
        },
        { fieldId: "fld_document", fieldName: "素材文档", type: 1, uiType: "Text" },
        { fieldId: "fld_name", fieldName: "命名", type: 1, uiType: "Text" },
        {
          fieldId: "fld_final_directory",
          fieldName: "成片状态",
          type: 3,
          uiType: "SingleSelect",
          options: [
            { id: "opt_final_directory_other", name: "未完成" },
            { id: "opt_final_directory", name: "已成片" },
          ],
        },
      ],
    }],
  });
  assert.equal(catalog.response.status, 201);
  const subject = catalog.body.catalog[0].subjects[0];
  const route = `/api/local/feishu/workflow/subjects/${encodeURIComponent(subject.subjectKey)}`;
  const draft = await request(fixtureData.baseUrl, route.replace("/api/local/feishu/workflow", "/api/local/feishu/workflow"), {
    // The request helper defaults to POST; use a direct PATCH below.
  });
  assert.equal(draft.response.status, 405);
  const patchResponse = await fetch(`${fixtureData.baseUrl}${route}`, {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
      "x-taskboard-client": "feishu-bridge",
      "x-feishu-bridge-secret": SECRET,
    },
    body: JSON.stringify({
      statusField: { fieldId: "fld_status", fieldName: "流程" },
      documentField: { fieldId: "fld_document", fieldName: "素材文档" },
      namingField: { fieldId: "fld_name", fieldName: "命名" },
      stages: {
        initial: stage("initial", "opt_initial", "初稿"),
        first_review: stage("first_review", "opt_review", "初审修改"),
        final_review: stage("final_review", "opt_final", "终审修改"),
      },
      trigger: { fieldId: "fld_status", fieldName: "流程", startValue: "初稿", optionId: "opt_initial" },
      title: { fieldId: null, fieldName: null },
      execution: { mode: "automatic", concurrencyGroup: "autocut", maxConcurrent: 3, resourceGroups: subjectResourceGroups },
      packageRoute: { routeMode: "fixed", packageAlias: "Auto-cut-lite", subjectCodeFieldId: null, branchMap: null },
      upload: {
        enabled: true,
        enqueueMode: "automatic",
        artifactSourceMode: "driver_report",
        artifactSourcePath: fixtureData.zipSourceDirectory,
        targetId: "target",
        targetPath: path.join(fixtureData.directory, "upload"),
        uploadConcurrency: 2,
      },
      ...(delivery === undefined ? {} : { delivery }),
    }),
  });
  assert.equal(patchResponse.status, 200);
  const patched = await patchResponse.json();
  const enable = await fetch(`${fixtureData.baseUrl}${route}/enable`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-taskboard-client": "feishu-bridge",
      "x-feishu-bridge-secret": SECRET,
    },
    body: JSON.stringify({ expectedVersion: patched.subject.configVersion }),
  });
  assert.equal(enable.status, 200);
  return (await enable.json()).subject;
}

function registration(subject, overrides = {}) {
  return {
    event: {
      eventId: "evt-stage-1",
      baseToken: "bas_stage",
      tableId: "tbl_math",
      recordId: "rec_1",
      statusFieldId: "fld_status",
      beforeOptionId: "opt_other",
      afterOptionId: "opt_initial",
      occurredAt: overrides.event?.occurredAt ?? Date.now(),
      ...overrides.event,
    },
    binding: {
      subjectKey: SUBJECT_KEY,
      configVersion: subject.configVersion,
      stageId: "initial",
      ...overrides.binding,
    },
    controlledContext: {
      documentLinks: ["https://guanghe.feishu.cn/docx/opaque-token"],
      namingDisplayValue: "课程001",
      namingValueUnique: true,
      ...overrides.controlledContext,
    },
  };
}

test("archived stage tasks can be deleted without recreating or executing deleted events", async () => {
  const f = await fixture();
  try {
    const subject = await enableSubject(f);
    const payload = registration(subject);
    const created = await request(f.baseUrl, "/api/local/feishu/tasks", payload);
    assert.equal(created.response.status, 201);
    const task = created.body.task;
    const archived = await request(f.baseUrl, `/api/tasks/${task.id}/archive`, { version: task.version });
    const deleted = await fetch(`${f.baseUrl}/api/tasks/${task.id}`, {
      method: "DELETE", headers: { "content-type": "application/json", "x-taskboard-client": "web" },
      body: JSON.stringify({ version: archived.body.task.version }),
    });
    assert.equal(deleted.status, 204, await deleted.text());
    assert.equal(f.app.database.getTask(task.id), null);
    const replay = await request(f.baseUrl, "/api/local/feishu/tasks", payload);
    assert.equal(replay.response.status, 410, JSON.stringify(replay.body));
    assert.equal(replay.body.error.code, "FEISHU_TASK_DELETED");
    const statePath = path.join(f.directory, "bridge-state.json");
    const bridgeSubject = Object.fromEntries([
      "subjectKey", "baseToken", "tableId", "tableName", "configVersion", "lifecycle", "statusField",
      "documentField", "namingField", "stages", "execution", "packageRoute", "upload",
    ].map((key) => [key, subject[key]]));
    const bridgeOptions = {
      bridgeSecret: SECRET,
      config: {
        tables: [bridgeSubject],
        packages: { "Auto-cut-lite": { projectId: "autocut-lite", workspacePath: f.workspace, prompt: "trusted package prompt" } },
        delivery: { maxAttempts: 2, initialDelayMs: 5, maxDelayMs: 5, leaseMs: 5000, pollIntervalMs: 100 },
      },
      workflowStore: { resolveSubjectVersionAt: async () => bridgeSubject },
      readControlledContext: async () => payload.controlledContext,
      taskboard: new TaskboardClient(f.baseUrl, { bridgeSecret: SECRET }),
    };
    const event = {
      ...payload.event, fieldId: "fld_status", fieldName: "流程", beforePresent: true, afterPresent: true,
      beforeValue: "其他", afterValue: "初稿", eventOccurredAt: payload.event.occurredAt,
      eventOccurredAtPresent: true, fields: {}, fieldValuesById: {},
    };
    const store = new JsonStateStore(statePath);
    const bridge = createBridge({ ...bridgeOptions, store });
    const ignored = { kind: "ignored", reason: "task_permanently_deleted" };
    assert.deepEqual(await bridge.handle(event), ignored);
    assert.equal((await store.get(event.eventId)).deliveryState, "succeeded");
    const restarted = createBridge({ ...bridgeOptions, store: new JsonStateStore(statePath) });
    assert.deepEqual(await restarted.handle(event), { ...ignored, duplicate: true });
    assert.equal(f.app.database.listFeishuTasks().length, 0);
    assert.equal(f.app.database.listTaskAiStarts().length, 0);
    const changed = structuredClone(payload);
    changed.controlledContext.namingDisplayValue = "Different input";
    const conflict = await request(f.baseUrl, "/api/local/feishu/tasks", changed);
    assert.equal(conflict.response.status, 409);
    assert.equal(conflict.body.error.code, "FEISHU_EVENT_BINDING_CONFLICT");
    const next = structuredClone(payload); next.event.eventId = "next-genuine-event";
    assert.equal((await request(f.baseUrl, "/api/local/feishu/tasks", next)).response.status, 201);
    f.app.database.database.exec("DELETE FROM feishu_subject_versions");
    assert.equal((await request(f.baseUrl, "/api/local/feishu/tasks", payload)).response.status, 410);
  } finally { await f.app.close(); await rm(f.directory, { recursive: true, force: true }); }
});

test("canonical stage registration derives execution policy from the enabled snapshot and replays idempotently", async () => {
  const fixtureData = await fixture();
  try {
    const subject = await enableSubject(fixtureData);
    const payload = registration(subject);
    const first = await request(fixtureData.baseUrl, "/api/local/feishu/tasks", payload);
    assert.equal(first.response.status, 201, JSON.stringify(first.body));
    assert.equal(first.body.task.feishuOrigin.stageId, "initial");
    assert.equal(first.body.task.feishuOrigin.configVersion, subject.configVersion);
    assert.equal(first.body.task.feishuOrigin.packageAlias, "Auto-cut-lite");
    assert.equal(first.body.task.feishuOrigin.executionMode, "automatic");

    const replay = await request(fixtureData.baseUrl, "/api/local/feishu/tasks", payload);
    assert.equal(replay.response.status, 200, JSON.stringify(replay.body));
    assert.equal(replay.body.task.id, first.body.task.id);
  } finally {
    await fixtureData.app.close();
    await rm(fixtureData.directory, { recursive: true, force: true });
  }
});

test("stage registration accepts a safe optional course name and keeps legacy context compatible", async () => {
  const fixtureData = await fixture();
  try {
    const subject = await enableSubject(fixtureData);
    const legacy = await request(fixtureData.baseUrl, "/api/local/feishu/tasks", registration(subject));
    assert.equal(legacy.response.status, 201, JSON.stringify(legacy.body));
    assert.deepEqual(legacy.body.task.feishuOrigin.controlledContext, {
      documentLinks: ["https://guanghe.feishu.cn/docx/opaque-token"],
      namingDisplayValue: "课程001",
      namingValueUnique: true,
    });

    const legacyEmpty = await request(fixtureData.baseUrl, "/api/local/feishu/tasks", registration(subject, {
      event: { eventId: "evt-stage-empty-course-name", recordId: "rec-empty-course-name" },
      controlledContext: { courseName: "" },
    }));
    assert.equal(legacyEmpty.response.status, 201, JSON.stringify(legacyEmpty.body));
    assert.equal(Object.hasOwn(legacyEmpty.body.task.feishuOrigin.controlledContext, "courseName"), false);

    const current = await request(fixtureData.baseUrl, "/api/local/feishu/tasks", registration(subject, {
      event: { eventId: "evt-stage-course-name", recordId: "rec-course-name" },
      controlledContext: { courseName: "课程001" },
    }));
    assert.equal(current.response.status, 201, JSON.stringify(current.body));
    assert.equal(current.body.task.feishuOrigin.controlledContext.courseName, "课程001");
    assert.equal(
      fixtureData.app.database.getFeishuTaskOrigin(current.body.task.id).controlledContext.courseName,
      "课程001",
    );
  } finally {
    await fixtureData.app.close();
    await rm(fixtureData.directory, { recursive: true, force: true });
  }
});

test("a delivery-configured stage freezes its bound course directory without creating it", async () => {
  const fixtureData = await fixture({
    coursePathResolver: {
      classifyDrive: async () => "local",
      resolveMappedDrive: async () => { throw new Error("local roots do not resolve UNC mappings"); },
    },
  });
  try {
    const subject = await enableSubject(fixtureData, {
      delivery: {
        version: 1,
        rootPath: "D:\\课程交付",
        courseNaming: { mode: "reuse_artifact_naming", fieldId: null },
        coursePathWriteback: { enabled: false, fieldId: null },
        writeback: {},
        finalDirectoryTrigger: { enabled: false, fieldId: null, optionId: null },
      },
    });
    const created = await request(fixtureData.baseUrl, "/api/local/feishu/tasks", registration(subject, {
      event: { eventId: "evt-stage-course-binding", recordId: "rec-course-binding" },
      controlledContext: { courseName: "课程001" },
    }));

    assert.equal(created.response.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.task.feishuOrigin.stageSnapshot.artifactTargetPath, "D:\\课程交付\\课程001\\01初稿");
    const binding = fixtureData.app.database.database.prepare(`
        SELECT course_name, course_path, display_path FROM feishu_course_bindings
        WHERE base_token = ? AND table_id = ? AND record_id = ?
      `).get("bas_stage", "tbl_math", "rec-course-binding");
    assert.deepEqual(
      { ...binding },
      {
        course_name: "课程001",
        course_path: "D:\\课程交付\\课程001",
        display_path: "课程交付\\课程001",
      },
    );
  } finally {
    await fixtureData.app.close();
    await rm(fixtureData.directory, { recursive: true, force: true });
  }
});

test("a frozen delivery stage passes its original root, course binding, and run to the ZIP queue", async () => {
  const fixtureData = await fixture({
    coursePathResolver: {
      classifyDrive: async () => "local",
      resolveMappedDrive: async () => { throw new Error("local roots do not resolve UNC mappings"); },
    },
  });
  try {
    const subject = await enableSubject(fixtureData, {
      delivery: {
        version: 1,
        rootPath: fixtureData.directory,
        courseNaming: { mode: "reuse_artifact_naming", fieldId: null },
        coursePathWriteback: { enabled: false, fieldId: null },
        writeback: {},
        finalDirectoryTrigger: { enabled: false, fieldId: null, optionId: null },
      },
    });
    const created = await request(fixtureData.baseUrl, "/api/local/feishu/tasks", registration(subject, {
      event: { eventId: "evt-stage-delivery-queue", recordId: "rec-delivery-queue" },
      controlledContext: { courseName: "课程001" },
    }));
    assert.equal(created.response.status, 201, JSON.stringify(created.body));
    const task = created.body.task;
    const run = fixtureData.app.database.createFeishuAutoCutRun({
      runId: "run-delivery-queue",
      taskId: task.id,
      subjectKey: subject.subjectKey,
      configVersion: subject.configVersion,
      stageId: "initial",
      eventId: "evt-stage-delivery-queue",
      resultPath: path.join(fixtureData.directory, "run-result.json"),
    });
    const now = new Date().toISOString();
    fixtureData.app.database.database.prepare(`
      INSERT INTO task_artifacts (
        id, task_id, run_id, storage_key, filename, content_type, size, sha256,
        source_mode, validation_status, entry_count, draft_root, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'application/zip', 1, ?, 'driver_report', 'verified', 1, 'draft', ?, ?)
    `).run(
      "artifact-delivery-queue",
      task.id,
      run.runId,
      "storage-delivery-queue",
      "课程001_初稿.zip",
      "a".repeat(64),
      now,
      now,
    );
    fixtureData.app.database.database.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(task.id);

    const queued = await request(
      fixtureData.baseUrl,
      `/api/local/tasks/${encodeURIComponent(task.id)}/upload-queue`,
      { artifactId: "artifact-delivery-queue" },
    );
    assert.equal(queued.response.status, 202, JSON.stringify(queued.body));
    const stored = fixtureData.app.database.database.prepare(`
      SELECT target_path, publication_root_path, course_binding_id, run_id
      FROM artifact_uploads WHERE id = ?
    `).get(queued.body.upload.id);
    const binding = fixtureData.app.database.database.prepare(`
      SELECT id, actual_root FROM feishu_course_bindings
      WHERE base_token = ? AND table_id = ? AND record_id = ?
    `).get("bas_stage", "tbl_math", "rec-delivery-queue");
    assert.deepEqual({ ...stored }, {
      target_path: path.join(fixtureData.directory, "课程001", "01初稿"),
      publication_root_path: binding.actual_root,
      course_binding_id: binding.id,
      run_id: run.runId,
    });
  } finally {
    await fixtureData.app.close();
    await rm(fixtureData.directory, { recursive: true, force: true });
  }
});

test("a real final-directory trigger creates only the bound 00 directory and is idempotent", async () => {
  const fixtureData = await fixture({
    coursePathResolver: {
      classifyDrive: async () => "local",
      resolveMappedDrive: async () => { throw new Error("local roots do not resolve UNC mappings"); },
    },
  });
  try {
    const subject = await enableSubject(fixtureData, {
      delivery: {
        version: 1,
        rootPath: fixtureData.directory,
        courseNaming: { mode: "reuse_artifact_naming", fieldId: null },
        coursePathWriteback: { enabled: false, fieldId: null },
        writeback: {},
        finalDirectoryTrigger: {
          enabled: true,
          fieldId: "fld_final_directory",
          optionId: "opt_final_directory",
        },
      },
    });
    const operation = {
      event: {
        eventId: "evt-final-directory-real",
        baseToken: "bas_stage",
        tableId: "tbl_math",
        recordId: "rec-final-directory",
        fieldId: "fld_final_directory",
        beforeOptionId: "opt_final_directory_other",
        afterOptionId: "opt_final_directory",
        occurredAt: Date.now(),
      },
      binding: { subjectKey: subject.subjectKey, configVersion: subject.configVersion },
      controlledContext: {
        documentLinks: [], namingDisplayValue: "课程001", namingValueUnique: true, courseName: "课程001",
      },
    };
    const created = await request(fixtureData.baseUrl, "/api/local/feishu/directory-operations", operation);
    assert.equal(created.response.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.operation.kind, "ensure_final_directory");
    assert.equal(created.body.operation.state, "succeeded");
    await access(path.join(fixtureData.directory, "课程001", "00成片"));
    assert.equal(fixtureData.app.database.listFeishuTasks().length, 0);
    assert.equal(fixtureData.app.database.listTaskAiStarts().length, 0);
    assert.equal(fixtureData.app.database.database.prepare("SELECT COUNT(*) AS count FROM feishu_writeback_outbox").get().count, 0);

    const replay = await request(fixtureData.baseUrl, "/api/local/feishu/directory-operations", operation);
    assert.equal(replay.response.status, 200, JSON.stringify(replay.body));
    assert.equal(replay.body.operation.id, created.body.operation.id);

    const simulated = await request(fixtureData.baseUrl, "/api/local/feishu/directory-operations", {
      ...operation,
      event: { ...operation.event, eventId: "evt-final-directory-simulated", deliverySource: "simulation" },
    });
    assert.equal(simulated.response.status, 409, JSON.stringify(simulated.body));
    assert.equal(simulated.body.error.code, "SIMULATION_DIRECTORY_OPERATION_FORBIDDEN");
    assert.equal(fixtureData.app.database.listFeishuTasks().length, 0);
  } finally {
    await fixtureData.app.close();
    await rm(fixtureData.directory, { recursive: true, force: true });
  }
});

test("stage registration rejects unsafe course names", async () => {
  const fixtureData = await fixture();
  try {
    const subject = await enableSubject(fixtureData);
    const invalidNames = [
      "课程/001",
      "课程\\001",
      "课程:001",
      "课程\u001f001",
      ".",
      "..",
      "课程.",
      "课程 ",
      "课".repeat(181),
    ];
    for (const [index, courseName] of invalidNames.entries()) {
      const result = await request(fixtureData.baseUrl, "/api/local/feishu/tasks", registration(subject, {
        event: { eventId: `evt-invalid-course-name-${index}`, recordId: `rec-invalid-course-name-${index}` },
        controlledContext: { courseName },
      }));
      assert.equal(result.response.status, 400, JSON.stringify(result.body));
      assert.equal(result.body.error.code, "INVALID_FIELD");
    }
  } finally {
    await fixtureData.app.close();
    await rm(fixtureData.directory, { recursive: true, force: true });
  }
});

test("new stage tasks freeze resource groups from their Auto-Cut package", async () => {
  const fixtureData = await fixture({ packageResourceGroups: [" 剪映主机 ", "音频工作站", "剪映主机"] });
  try {
    const subject = await enableSubject(fixtureData, { subjectResourceGroups: ["legacy-subject-lock"] });
    const created = await request(fixtureData.baseUrl, "/api/local/feishu/tasks", registration(subject, {
      event: { eventId: "evt-package-resource-groups" },
    }));
    assert.equal(created.response.status, 201, JSON.stringify(created.body));
    assert.deepEqual(
      fixtureData.app.database.getFeishuTaskPackageSnapshot(created.body.task.id).resourceGroups,
      ["剪映主机", "音频工作站"],
    );
    assert.deepEqual(created.body.task.feishuOrigin.resourceGroups, ["剪映主机", "音频工作站"]);

    const packageBeforeChange = await fetch(`${fixtureData.baseUrl}/api/local/autocut/packages/Auto-cut-lite`)
      .then((response) => response.json());
    const changedPackage = await fetch(`${fixtureData.baseUrl}/api/local/autocut/packages/Auto-cut-lite`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        revision: packageBeforeChange.package.revision,
        resourceGroups: ["新资源主机"],
      }),
    });
    assert.equal(changedPackage.status, 200, await changedPackage.text());
    assert.deepEqual(
      fixtureData.app.database.getFeishuTaskPackageSnapshot(created.body.task.id).resourceGroups,
      ["剪映主机", "音频工作站"],
    );

    const next = await request(fixtureData.baseUrl, "/api/local/feishu/tasks", registration(subject, {
      event: { eventId: "evt-package-resource-groups-next", recordId: "rec_2" },
    }));
    assert.equal(next.response.status, 201, JSON.stringify(next.body));
    assert.deepEqual(
      fixtureData.app.database.getFeishuTaskPackageSnapshot(next.body.task.id).resourceGroups,
      ["新资源主机"],
    );
  } finally {
    await fixtureData.app.close();
    await rm(fixtureData.directory, { recursive: true, force: true });
  }
});

test("stage task titles use the captured naming field with a record ID fallback", async () => {
  const fixtureData = await fixture();
  try {
    const subject = await enableSubject(fixtureData);
    for (const [index, namingDisplayValue, expectedName] of [
      [0, "  中国古代史 第一课  ", "中国古代史 第一课"],
      [1, "", "rec_1"],
      [2, "   ", "rec_1"],
      [3, undefined, "rec_1"],
    ]) {
      const payload = registration(subject, {
        event: { eventId: `evt-naming-${index}` },
        controlledContext: { namingDisplayValue, namingValueUnique: false },
      });
      const result = await request(fixtureData.baseUrl, "/api/local/feishu/tasks", payload);
      assert.equal(result.response.status, 201, JSON.stringify(result.body));
      assert.equal(result.body.task.title, `数学 · ${expectedName} · _初稿`);
      assert.equal(result.body.task.feishuOrigin.recordId, "rec_1");
      assert.equal(result.body.task.feishuOrigin.controlledContext.namingValueUnique, false);
      assert.equal(fixtureData.app.database.database.prepare("SELECT title FROM tasks WHERE id = ?")
        .get(result.body.task.id).title, result.body.task.title);
    }
  } finally {
    await fixtureData.app.close();
    await rm(fixtureData.directory, { recursive: true, force: true });
  }
});

test("long naming snapshots produce editable new and historical task titles", async () => {
  const f = await fixture();
  try {
    const subject = await enableSubject(f);
    const name = "课程📚".repeat(60);
    const payload = registration(subject, { controlledContext: { namingDisplayValue: name } });
    const created = await request(f.baseUrl, "/api/local/feishu/tasks", payload);
    assert.equal(created.response.status, 201);
    const task = created.body.task;
    assert.ok(task.title.length <= 240);
    assert.ok(task.title.startsWith("数学 · "));
    assert.ok(task.title.endsWith(" · _初稿"));
    assert.equal(task.feishuOrigin.controlledContext.namingDisplayValue, name);
    f.app.database.database.prepare("UPDATE tasks SET title = ? WHERE id = ?")
      .run("数学 · rec_1 · _初稿", task.id);
    const projected = f.app.database.getTask(task.id);
    assert.equal(projected.title, task.title);
    const response = await fetch(`${f.baseUrl}/api/tasks/${task.id}`, {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ version: projected.version, title: projected.title, priority: "high" }),
    });
    const patched = await response.json();
    assert.equal(response.status, 200, JSON.stringify(patched));
    assert.equal(patched.task.priority, "high");
    assert.equal(patched.task.feishuOrigin.controlledContext.namingDisplayValue, name);
  } finally {
    await f.app.close(); await rm(f.directory, { recursive: true, force: true });
  }
});

test("historical generated task titles display stored names without rewriting identity or custom titles", async () => {
  const fixtureData = await fixture();
  try {
    const subject = await enableSubject(fixtureData);
    const payload = registration(subject);
    const created = await request(fixtureData.baseUrl, "/api/local/feishu/tasks", payload);
    assert.equal(created.response.status, 201, JSON.stringify(created.body));
    const { id, version, updatedAt } = created.body.task;
    const database = fixtureData.app.database;
    const sql = database.database;
    const storedOrigin = sql.prepare("SELECT * FROM feishu_task_origins WHERE task_id = ?").get(id);
    // Model the title emitted by releases before the naming-field fix.
    sql.prepare("UPDATE tasks SET title = ? WHERE id = ?").run("数学 · rec_1 · _初稿", id);
    const title = "数学 · 课程001 · _初稿";
    assert.equal(database.getTask(id).title, title);
    assert.equal(database.listTasks({}).find((task) => task.id === id).title, title);
    const detail = await fetch(`${fixtureData.baseUrl}/api/tasks/${id}`);
    assert.equal(detail.status, 200);
    assert.equal((await detail.json()).task.title, title);
    const replay = await request(fixtureData.baseUrl, "/api/local/feishu/tasks", payload);
    assert.equal(replay.response.status, 200);
    assert.equal(replay.body.task.title, title);
    assert.equal(replay.body.task.version, version);
    assert.equal(replay.body.task.updatedAt, updatedAt);
    assert.deepEqual(sql.prepare("SELECT * FROM feishu_task_origins WHERE task_id = ?").get(id), storedOrigin);
    assert.equal(sql.prepare("SELECT title FROM tasks WHERE id = ?").get(id).title, "数学 · rec_1 · _初稿");

    const archived = await request(fixtureData.baseUrl, `/api/tasks/${id}/archive`, { version });
    assert.equal(archived.response.status, 200);
    assert.equal(database.listTasks({ archived: "true" }).find((task) => task.id === id).title, title);

    sql.prepare("UPDATE tasks SET title = ? WHERE id = ?").run("我的课程标题 · rec_1 · _初稿", id);
    assert.equal(database.getTask(id).title, "我的课程标题 · rec_1 · _初稿");
    assert.equal(database.listTasks({}).find((task) => task.id === id).title, "我的课程标题 · rec_1 · _初稿");

    sql.prepare("UPDATE tasks SET title = ? WHERE id = ?").run("数学 · rec_1 · _初稿", id);
    for (const namingDisplayValue of ["", "   "]) {
      const context = { ...payload.controlledContext, namingDisplayValue };
      sql.prepare("UPDATE feishu_task_origins SET controlled_context_json = ? WHERE task_id = ?")
        .run(JSON.stringify(context), id);
      assert.equal(database.getTask(id).title, "数学 · rec_1 · _初稿");
    }
    sql.prepare("UPDATE feishu_task_origins SET controlled_context_json = ? WHERE task_id = ?")
      .run(storedOrigin.controlled_context_json, id);
    sql.prepare("DELETE FROM feishu_subject_versions WHERE subject_key = ? AND version = ?")
      .run(subject.subjectKey, subject.configVersion);
    assert.equal(database.getTask(id).title, "数学 · rec_1 · _初稿");
  } finally {
    await fixtureData.app.close();
    await rm(fixtureData.directory, { recursive: true, force: true });
  }
});

test("canonical stage registration still schedules automatic execution internally", async () => {
  const fixtureData = await fixture({ allowAutomaticExecution: true });
  try {
    const subject = await enableSubject(fixtureData);
    const registeredAt = Date.now();
    const result = await request(
      fixtureData.baseUrl,
      "/api/local/feishu/tasks",
      registration(subject, { event: { eventId: "evt-stage-internal-automatic" } }),
    );
    assert.equal(result.response.status, 201, JSON.stringify(result.body));
    await new Promise((resolve) => setImmediate(resolve));

    const execution = fixtureData.app.database.getFeishuExecution(result.body.task.id);
    assert.equal(execution?.trigger, "automatic");
    assert.equal(execution?.mode, "automatic");
    assert.equal(execution?.state, "delayed");
    assert.ok(execution.readyAt >= registeredAt + 4_000);
    assert.equal(fixtureData.app.database.getTask(result.body.task.id).status, "todo");
  } finally {
    await fixtureData.app.close();
    await rm(fixtureData.directory, { recursive: true, force: true });
  }
});

test("archiving a canonical stage task cancels its delayed automatic execution", async () => {
  const fixtureData = await fixture({ allowAutomaticExecution: true });
  try {
    const subject = await enableSubject(fixtureData);
    const registered = await request(
      fixtureData.baseUrl,
      "/api/local/feishu/tasks",
      registration(subject, { event: { eventId: "evt-stage-archive-cancels-execution" } }),
    );
    assert.equal(registered.response.status, 201, JSON.stringify(registered.body));
    await new Promise((resolve) => setImmediate(resolve));

    const taskId = registered.body.task.id;
    const execution = fixtureData.app.database.getFeishuExecution(taskId);
    assert.equal(execution?.state, "delayed");

    const archived = await request(
      fixtureData.baseUrl,
      `/api/local/feishu/tasks/${encodeURIComponent(taskId)}/archive`,
      { version: registered.body.task.version },
    );
    assert.equal(archived.response.status, 200, JSON.stringify(archived.body));
    assert.ok(archived.body.task.archivedAt);
    assert.equal(fixtureData.app.database.getFeishuExecution(taskId), null);
  } finally {
    await fixtureData.app.close();
    await rm(fixtureData.directory, { recursive: true, force: true });
  }
});

test("canonical replay heals a task committed before its automatic reservation", async () => {
  const fixtureData = await fixture({ allowAutomaticExecution: true });
  try {
    const subject = await enableSubject(fixtureData);
    const payload = registration(subject, {
      event: { eventId: "evt-stage-automatic-reservation-replay" },
    });
    const createExecution = fixtureData.app.database.createFeishuExecution.bind(fixtureData.app.database);
    fixtureData.app.database.createFeishuExecution = () => {
      const error = new Error("injected execution reservation failure");
      error.code = "EXECUTION_RESERVATION_FAILED";
      throw error;
    };

    const logged = [];
    const originalConsoleError = console.error;
    console.error = (...args) => logged.push(args.map(String).join(" "));
    let interrupted;
    try {
      interrupted = await request(fixtureData.baseUrl, "/api/local/feishu/tasks", payload);
    } finally {
      console.error = originalConsoleError;
    }
    assert.equal(interrupted.response.status, 500, JSON.stringify(interrupted.body));
    assert.deepEqual(logged, ["INTERNAL_ERROR"]);
    await new Promise((resolve) => setImmediate(resolve));
    const committed = fixtureData.app.database.findFeishuTaskByRegistration({
      baseToken: payload.event.baseToken,
      tableId: payload.event.tableId,
      recordId: payload.event.recordId,
      statusFieldId: payload.event.statusFieldId,
      stageId: payload.binding.stageId,
      eventId: payload.event.eventId,
    });
    assert.ok(committed);
    assert.equal(fixtureData.app.database.getFeishuExecution(committed.id), null);

    fixtureData.app.database.createFeishuExecution = createExecution;
    const packageCatalog = await fetch(`${fixtureData.baseUrl}/api/local/autocut/packages`).then(
      (response) => response.json(),
    );
    const packageRecord = packageCatalog.packages.find((entry) => entry.alias === "Auto-cut-lite");
    const disabled = await fetch(
      `${fixtureData.baseUrl}/api/local/autocut/packages/Auto-cut-lite/disable`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ revision: packageRecord.revision }),
      },
    );
    assert.equal(disabled.status, 200);

    const replay = await request(fixtureData.baseUrl, "/api/local/feishu/tasks", payload);
    assert.equal(replay.response.status, 200, JSON.stringify(replay.body));
    assert.equal(replay.body.task.id, committed.id);
    const execution = fixtureData.app.database.getFeishuExecution(committed.id);
    assert.equal(execution?.trigger, "automatic");
    assert.equal(execution?.mode, "automatic");
    assert.equal(execution?.state, "delayed");
  } finally {
    await fixtureData.app.close();
    await rm(fixtureData.directory, { recursive: true, force: true });
  }
});

test("simulated stage registration is never eligible for automatic execution", async () => {
  const fixtureData = await fixture({ allowAutomaticExecution: true });
  try {
    const subject = await enableSubject(fixtureData);
    const simulated = await request(
      fixtureData.baseUrl,
      "/api/local/feishu/tasks",
      registration(subject, {
        event: { eventId: "evt-stage-simulated", deliverySource: "simulation" },
      }),
    );
    assert.equal(simulated.response.status, 201, JSON.stringify(simulated.body));
    assert.equal(simulated.body.task.status, "todo");
    assert.equal(simulated.body.task.feishuOrigin.deliverySource, "simulation");
    assert.equal(simulated.body.task.feishuOrigin.mode, "manual");
    assert.equal(simulated.body.task.feishuOrigin.executionMode, "manual");
    assert.equal(simulated.body.task.feishuOrigin.uploadMode, "automatic");
    await new Promise((resolve) => setTimeout(resolve, 100));
    const stored = fixtureData.app.database.getTask(simulated.body.task.id);
    assert.equal(stored.status, "todo");
    assert.equal(stored.threadId, null);
    assert.equal(fixtureData.app.database.getFeishuExecution(stored.id), null);
  } finally {
    await fixtureData.app.close();
    await rm(fixtureData.directory, { recursive: true, force: true });
  }
});

test("a simulated stage task cannot enqueue a verified ZIP for publication", async () => {
  const fixtureData = await fixture();
  try {
    const subject = await enableSubject(fixtureData);
    const simulated = await request(
      fixtureData.baseUrl,
      "/api/local/feishu/tasks",
      registration(subject, { event: { eventId: "evt-stage-simulated-upload", deliverySource: "simulation" } }),
    );
    assert.equal(simulated.response.status, 201, JSON.stringify(simulated.body));
    const task = simulated.body.task;
    const timestamp = new Date().toISOString();
    fixtureData.app.database.database.prepare(`
      INSERT INTO task_artifacts (
        id, task_id, run_id, storage_key, filename, content_type, size, sha256,
        source_mode, validation_status, entry_count, draft_root, created_at, updated_at
      ) VALUES (?, ?, NULL, ?, ?, 'application/zip', 1, ?, 'manual_select', 'verified', 1, 'draft', ?, ?)
    `).run(
      "artifact-simulated-upload",
      task.id,
      "storage-simulated-upload",
      "课程001_初稿.zip",
      "b".repeat(64),
      timestamp,
      timestamp,
    );
    fixtureData.app.database.database.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(task.id);

    const queued = await request(
      fixtureData.baseUrl,
      `/api/local/tasks/${encodeURIComponent(task.id)}/upload-queue`,
      { artifactId: "artifact-simulated-upload" },
    );
    assert.equal(queued.response.status, 409, JSON.stringify(queued.body));
    assert.equal(queued.body.error.code, "SIMULATION_UPLOAD_FORBIDDEN");
    assert.equal(fixtureData.app.database.database.prepare("SELECT COUNT(*) AS count FROM artifact_uploads").get().count, 0);
  } finally {
    await fixtureData.app.close();
    await rm(fixtureData.directory, { recursive: true, force: true });
  }
});

test("a legacy failed upload for a simulated stage task cannot be retried", async () => {
  const fixtureData = await fixture({
    uploadWorker: { start() {}, wake() {}, async close() {} },
  });
  try {
    const subject = await enableSubject(fixtureData);
    const simulated = await request(
      fixtureData.baseUrl,
      "/api/local/feishu/tasks",
      registration(subject, { event: { eventId: "evt-stage-simulated-retry", deliverySource: "simulation" } }),
    );
    assert.equal(simulated.response.status, 201, JSON.stringify(simulated.body));
    const task = simulated.body.task;
    const timestamp = new Date().toISOString();
    fixtureData.app.database.database.prepare(`
      INSERT INTO task_artifacts (
        id, task_id, run_id, storage_key, filename, content_type, size, sha256,
        source_mode, validation_status, entry_count, draft_root, created_at, updated_at
      ) VALUES (?, ?, NULL, ?, ?, 'application/zip', 1, ?, 'manual_select', 'verified', 1, 'draft', ?, ?)
    `).run(
      "artifact-simulated-retry",
      task.id,
      "storage-simulated-retry",
      "课程001_初稿.zip",
      "c".repeat(64),
      timestamp,
      timestamp,
    );
    const upload = fixtureData.app.database.createArtifactUpload({
      taskId: task.id,
      artifactId: "artifact-simulated-retry",
      subjectKey: SUBJECT_KEY,
      storageKey: "storage-simulated-retry",
      targetId: "target",
      targetPath: path.join(fixtureData.directory, "upload"),
      filename: "课程001_初稿.zip",
      sha256: "c".repeat(64),
      uploadConcurrency: 1,
    });
    fixtureData.app.database.database.prepare(`
      UPDATE artifact_uploads SET status = 'failed', error_code = 'FIXTURE_FAILED' WHERE id = ?
    `).run(upload.id);

    const retried = await request(
      fixtureData.baseUrl,
      `/api/local/tasks/${encodeURIComponent(task.id)}/upload/retry`,
      { uploadId: upload.id },
    );

    assert.equal(retried.response.status, 409, JSON.stringify(retried.body));
    assert.equal(retried.body.error.code, "SIMULATION_UPLOAD_FORBIDDEN");
    assert.equal(fixtureData.app.database.getArtifactUpload(upload.id).status, "failed");
  } finally {
    await fixtureData.app.close();
    await rm(fixtureData.directory, { recursive: true, force: true });
  }
});

test("workflow synchronization carries the selected course-name field descriptor", async () => {
  let synchronized = null;
  const bridge = createServer(async (incoming, response) => {
    let body = "";
    for await (const chunk of incoming) body += chunk;
    if (incoming.method !== "POST" || incoming.url !== "/api/feishu/workflow/sync") {
      response.writeHead(404).end();
      return;
    }
    synchronized = JSON.parse(body);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ subject: synchronized.subject }));
  });
  await new Promise((resolve) => bridge.listen(0, "127.0.0.1", resolve));
  const fixtureData = await fixture({
    feishuBridgeUrl: `http://127.0.0.1:${bridge.address().port}`,
    feishuWorkflowSync: null,
  });
  try {
    await enableSubject(fixtureData, {
      delivery: {
        version: 1,
        rootPath: "D:\\课程交付",
        courseNaming: { mode: "field", fieldId: "fld_name" },
        coursePathWriteback: { enabled: false, fieldId: null },
        writeback: {},
        finalDirectoryTrigger: { enabled: false, fieldId: null, optionId: null },
      },
    });
    assert.deepEqual(synchronized?.subject.courseNamingField, {
      fieldId: "fld_name",
      fieldName: "命名",
      type: 1,
      uiType: "Text",
    });
  } finally {
    await fixtureData.app.close();
    await new Promise((resolve) => bridge.close(resolve));
    await rm(fixtureData.directory, { recursive: true, force: true });
  }
});

test("canonical replay rejects altered controlled context for the same registration identity", async () => {
  const fixtureData = await fixture();
  try {
    const subject = await enableSubject(fixtureData);
    const payload = registration(subject, { event: { eventId: "evt-stage-context-conflict" } });
    const first = await request(fixtureData.baseUrl, "/api/local/feishu/tasks", payload);
    assert.equal(first.response.status, 201, JSON.stringify(first.body));

    const conflict = await request(
      fixtureData.baseUrl,
      "/api/local/feishu/tasks",
      registration(subject, {
        event: { eventId: payload.event.eventId, occurredAt: payload.event.occurredAt },
        controlledContext: { namingDisplayValue: "altered-name" },
      }),
    );
    assert.equal(conflict.response.status, 409, JSON.stringify(conflict.body));
    assert.equal(conflict.body.error.code, "FEISHU_EVENT_BINDING_CONFLICT");
  } finally {
    await fixtureData.app.close();
    await rm(fixtureData.directory, { recursive: true, force: true });
  }
});

test("canonical stage registration rejects an event rebound to another stage", async () => {
  const fixtureData = await fixture();
  try {
    const subject = await enableSubject(fixtureData);
    const payload = registration(subject);
    const first = await request(fixtureData.baseUrl, "/api/local/feishu/tasks", payload);
    assert.equal(first.response.status, 201, JSON.stringify(first.body));
    const conflict = await request(
      fixtureData.baseUrl,
      "/api/local/feishu/tasks",
      registration(subject, {
        binding: { stageId: "final_review" },
        event: { afterOptionId: "opt_final", occurredAt: payload.event.occurredAt },
      }),
    );
    assert.equal(conflict.response.status, 409, JSON.stringify(conflict.body));
    assert.equal(conflict.body.error.code, "FEISHU_EVENT_BINDING_CONFLICT");
  } finally {
    await fixtureData.app.close();
    await rm(fixtureData.directory, { recursive: true, force: true });
  }
});

test("canonical stage registration rejects an event id rebound to another record", async () => {
  const fixtureData = await fixture();
  try {
    const subject = await enableSubject(fixtureData);
    const payload = registration(subject, { event: { eventId: "evt-stage-record-rebound" } });
    const first = await request(fixtureData.baseUrl, "/api/local/feishu/tasks", payload);
    assert.equal(first.response.status, 201, JSON.stringify(first.body));

    const conflict = await request(
      fixtureData.baseUrl,
      "/api/local/feishu/tasks",
      registration(subject, {
        event: {
          eventId: payload.event.eventId,
          recordId: "rec_2",
          occurredAt: payload.event.occurredAt,
        },
      }),
    );

    assert.equal(conflict.response.status, 409, JSON.stringify(conflict.body));
    assert.equal(conflict.body.error.code, "FEISHU_EVENT_BINDING_CONFLICT");
    assert.equal(fixtureData.app.database.listFeishuTasks().length, 1);
  } finally {
    await fixtureData.app.close();
    await rm(fixtureData.directory, { recursive: true, force: true });
  }
});
