import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { TaskboardDatabase } from "../server/database.mjs";
import { subjectProjectId } from "../server/feishu-workflow-store.mjs";
import { createVmTaskRegistration, createVmRegistrationRecordReader } from "../server/vm-task-registration.mjs";

const TEMPLATE = { id: "vm_pmo_review_video", version: 1 };
const ACTOR = { type: "agent", id: "bridge", name: "Feishu Bridge", avatarUrl: null };
const VMID = "5dd7753a4723ba416403cbad";

function subject() {
  return { subjectKey: "bas_vm:tbl_vm", baseToken: "bas_vm", tableId: "tbl_vm", tableName: "VM 测试",
    projectId: subjectProjectId("bas_vm:tbl_vm"), lifecycle: "enabled", configVersion: 4,
    enabledAt: 100, closedAt: null, workflowTemplate: TEMPLATE,
    packageRoute: { packageAlias: "auto-cut-slicing" }, execution: { mode: "automatic" },
    statusField: { fieldId: "fld_status", type: "single_select", options: [
      { optionId: "opt_other", name: "准备" }, { optionId: "opt_initial", name: "待剪辑" }] },
    metadata: { fields: [
      { fieldId: "fld_status", fieldName: "制作进度", type: 3, uiType: "SingleSelect", options: [
        { id: "opt_other", name: "准备" }, { id: "opt_initial", name: "待剪辑" }] },
      { fieldId: "fld_vmid", fieldName: "原视频vmid", type: 1, uiType: "Text" },
      { fieldId: "fld_name", fieldName: "名称", type: 1, uiType: "Text" },
      { fieldId: "fld_instruction", fieldName: "初稿意见", type: 1, uiType: "Text" },
    ] },
    vmWorkflow: { fields: { vmidFieldId: "fld_vmid", namingFieldId: "fld_name", outputAttachmentFieldId: "fld_output" },
      stages: { initial: { enabled: true, statusFieldId: "fld_status", triggerOptionId: "opt_initial",
        instructionFieldId: "fld_instruction" }, review: { enabled: false } }, finalArchive: { enabled: false } } };
}

function registration(patch = {}) {
  return { event: { eventId: "evt_vm", baseToken: "bas_vm", tableId: "tbl_vm", recordId: "rec_vm",
    statusFieldId: "fld_status", beforeOptionId: "opt_other", afterOptionId: "opt_initial", occurredAt: 200,
    ...patch.event }, binding: { subjectKey: "bas_vm:tbl_vm", configVersion: 4, stageId: "initial", ...patch.binding } };
}

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vm-registration-"));
  const workspacePath = path.join(directory, "package");
  await mkdir(workspacePath);
  await writeFile(path.join(workspacePath, "PACKAGE-MANIFEST.json"), JSON.stringify({ interface: {
    workflowTemplate: TEMPLATE, contract: TEMPLATE, driverId: "vm_pmo_review_video_v1" } }));
  const database = new TaskboardDatabase(path.join(directory, "taskboard.sqlite"));
  const active = subject();
  database.createProject({ id: active.projectId, name: "VM 测试", workspacePath: directory });
  const values = { active, frozen: structuredClone(active), record: { vmid: VMID, title: "化学变化中微粒怎么变？",
    instruction: "仅保留 00:00–00:20", statusOptionId: "opt_initial" },
    package: { alias: "auto-cut-slicing", state: "enabled", revision: 2, workflowTemplate: TEMPLATE,
      workspacePath, prompt: "trusted package command", maxConcurrent: 1, resourceGroups: ["vm-render"] }, reads: 0 };
  database.getFeishuSubjectVersion = () => structuredClone(values.frozen);
  database.resolveFeishuSubjectVersionAt = () => structuredClone(values.frozen);
  const create = (overrides = {}) => createVmTaskRegistration({ database,
    getActiveSubject: async () => structuredClone(values.active), getPackage: async () => structuredClone(values.package),
    readCurrentRecord: async () => { values.reads++; return structuredClone(values.record); }, ...overrides });
  t.after(async () => { database.close(); await rm(directory, { recursive: true, force: true }); });
  return { database, values, create, service: create() };
}

function createIntentTable(database) {
  database.database.exec("CREATE TABLE registration_intents (task_id TEXT PRIMARY KEY REFERENCES tasks(id))");
}

function registrationCounts(database) {
  return Object.fromEntries(["tasks", "feishu_task_origins", "feishu_task_package_snapshots", "registration_intents"]
    .map((table) => [table, database.database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count]));
}

test("failed asynchronous preparation leaves no task and the same event can retry", async (t) => {
  const f = await fixture(t);
  createIntentTable(f.database);
  let attempts = 0;
  const service = f.create({ prepareCommit: async ({ subject, packageRecord, snapshot, origin }) => {
    attempts++;
    assert.equal(subject.subjectKey, "bas_vm:tbl_vm");
    assert.equal(packageRecord.alias, "auto-cut-slicing");
    assert.equal(snapshot.packageRevision, 2);
    assert.equal(origin.stageSnapshot.vmContext.vmid, VMID);
    if (attempts === 1) throw new Error("temporary local policy failure");
    return ({ taskId, database }) => {
      assert.ok(database.getTask(taskId));
      assert.equal(database.getFeishuTaskOrigin(taskId).eventId, "evt_vm");
      assert.equal(database.getFeishuTaskPackageSnapshot(taskId).packageRevision, 2);
      database.database.prepare("INSERT INTO registration_intents (task_id) VALUES (?)").run(taskId);
    };
  } });
  await assert.rejects(() => service.register(registration(), ACTOR), /temporary local policy failure/);
  assert.deepEqual(registrationCounts(f.database), { tasks: 0, feishu_task_origins: 0,
    feishu_task_package_snapshots: 0, registration_intents: 0 });
  const retry = await service.register(registration(), ACTOR);
  assert.equal(retry.created, true);
  assert.deepEqual(registrationCounts(f.database), { tasks: 1, feishu_task_origins: 1,
    feishu_task_package_snapshots: 1, registration_intents: 1 });
});

test("failed intent insertion rolls back task, origin, snapshot and project counter together", async (t) => {
  const f = await fixture(t);
  createIntentTable(f.database);
  const before = f.database.database.prepare("SELECT next_task_number, labels FROM projects WHERE id = ?").get(f.values.active.projectId);
  let shouldFail = true;
  const service = f.create({ prepareCommit: async () => ({ taskId, database }) => {
    database.database.prepare("INSERT INTO registration_intents (task_id) VALUES (?)").run(taskId);
    if (shouldFail) throw new Error("intent persistence failure");
  } });
  await assert.rejects(() => service.register(registration(), ACTOR), /intent persistence failure/);
  assert.deepEqual(registrationCounts(f.database), { tasks: 0, feishu_task_origins: 0,
    feishu_task_package_snapshots: 0, registration_intents: 0 });
  assert.deepEqual(f.database.database.prepare("SELECT next_task_number, labels FROM projects WHERE id = ?").get(f.values.active.projectId), before);
  shouldFail = false;
  const retry = await service.register(registration(), ACTOR);
  assert.equal(retry.created, true);
  assert.deepEqual(registrationCounts(f.database), { tasks: 1, feishu_task_origins: 1,
    feishu_task_package_snapshots: 1, registration_intents: 1 });
});

test("event replay never prepares a new automatic intent for a historical task", async (t) => {
  const f = await fixture(t);
  createIntentTable(f.database);
  const first = await f.service.register(registration(), ACTOR);
  let prepared = 0;
  const service = f.create({ prepareCommit: async () => {
    prepared++;
    return ({ taskId, database }) => database.database.prepare("INSERT INTO registration_intents (task_id) VALUES (?)").run(taskId);
  } });
  const replay = await service.register(registration(), ACTOR);
  assert.equal(replay.created, false);
  assert.equal(replay.task.id, first.task.id);
  assert.equal(prepared, 0);
  assert.equal(registrationCounts(f.database).registration_intents, 0);
});

test("parallel event deliveries commit only the winner's intent", async (t) => {
  const f = await fixture(t);
  createIntentTable(f.database);
  let committed = 0;
  const service = f.create({ prepareCommit: async () => ({ taskId, database }) => {
    committed++;
    database.database.prepare("INSERT INTO registration_intents (task_id) VALUES (?)").run(taskId);
  } });
  const results = await Promise.all([service.register(registration(), ACTOR), service.register(registration(), ACTOR)]);
  assert.equal(results.filter(({ created }) => created).length, 1);
  assert.equal(committed, 1);
  assert.deepEqual(registrationCounts(f.database), { tasks: 1, feishu_task_origins: 1,
    feishu_task_package_snapshots: 1, registration_intents: 1 });
});

test("configuration changes during asynchronous preparation are rechecked before creation", async (t) => {
  const f = await fixture(t);
  const service = f.create({ prepareCommit: async () => {
    f.values.active.lifecycle = "disabled";
    return () => assert.fail("stale configuration must never commit an intent");
  } });
  await assert.rejects(() => service.register(registration(), ACTOR), { code: "STALE_STAGE_EVENT" });
  assert.equal(f.database.listFeishuTasks().length, 0);
});

test("transaction intent callbacks reject asynchronous work without committing a task", async (t) => {
  const f = await fixture(t);
  createIntentTable(f.database);
  let invokedAsync = false;
  const asyncService = f.create({ prepareCommit: async () => async () => { invokedAsync = true; } });
  await assert.rejects(() => asyncService.register(registration(), ACTOR), { code: "FEISHU_TRANSACTION_CALLBACK_INVALID" });
  assert.equal(invokedAsync, false);
  const promiseService = f.create({ prepareCommit: async () => ({ taskId, database }) => {
    database.database.prepare("INSERT INTO registration_intents (task_id) VALUES (?)").run(taskId);
    return Promise.reject(new Error("unexpected asynchronous result"));
  } });
  await assert.rejects(() => promiseService.register(registration(), ACTOR), { code: "FEISHU_TRANSACTION_CALLBACK_INVALID" });
  assert.deepEqual(registrationCounts(f.database), { tasks: 0, feishu_task_origins: 0,
    feishu_task_package_snapshots: 0, registration_intents: 0 });
});

test("VM registration creates trusted todo origin and frozen package/PMO context", async (t) => {
  const f = await fixture(t);
  const result = await f.service.register(registration(), ACTOR);
  assert.equal(result.created, true);
  assert.equal(result.task.status, "todo");
  assert.equal(result.origin.source, "feishu-base");
  assert.equal(result.origin.packageAlias, "auto-cut-slicing");
  assert.equal(result.origin.executionMode, "automatic");
  assert.deepEqual(result.origin.stageSnapshot.vmContext, f.values.record);
  assert.deepEqual(result.origin.stageSnapshot.vmWorkflow, f.values.frozen.vmWorkflow);
  assert.equal(f.database.getFeishuTaskPackageSnapshot(result.task.id).packageRevision, 2);
  assert.doesNotMatch(result.task.description, /trusted package command|workspacePath|原视频vmid/);
  assert.match(result.task.title, /化学变化中微粒怎么变/);
});

test("VM registration preserves instruction whitespace and normalizes only identifiers and names", async (t) => {
  const f = await fixture(t);
  f.values.record.vmid = ` ${VMID} `;
  f.values.record.title = "  化学变化中微粒怎么变？  ";
  f.values.record.instruction = "\n  仅保留 00:00–00:20  \n";
  const result = await f.service.register(registration(), ACTOR);
  assert.deepEqual(result.origin.stageSnapshot.vmContext, {
    vmid: VMID, title: "化学变化中微粒怎么变？", instruction: f.values.record.instruction,
    statusOptionId: "opt_initial",
  });
});

test("VM registration accepts the registry's controlled Chinese aliases and resource labels", async (t) => {
  const f = await fixture(t);
  f.values.active.packageRoute.packageAlias = "化学剪辑包";
  f.values.frozen.packageRoute.packageAlias = "化学剪辑包";
  f.values.package.alias = "化学剪辑包";
  f.values.package.resourceGroups = ["剪辑 主机"];
  const result = await f.service.register(registration(), ACTOR);
  assert.equal(result.origin.packageAlias, "化学剪辑包");
  assert.deepEqual(f.database.getFeishuTaskPackageSnapshot(result.task.id).resourceGroups, ["剪辑 主机"]);
});

test("VM registration rejects aliases forbidden by the saved registry contract", async (t) => {
  const f = await fixture(t);
  for (const alias of ["__proto__", "constructor", "prototype", "../package", "包 别名", "pkg:command", "pkg`command"] ) {
    f.values.active.packageRoute.packageAlias = alias;
    f.values.frozen.packageRoute.packageAlias = alias;
    f.values.package.alias = alias;
    await assert.rejects(() => f.service.register(registration(), ACTOR), { code: "VM_WORKFLOW_NOT_READY" });
  }
  assert.equal(f.database.listFeishuTasks().length, 0);
});

test("same event replay survives service restart and PMO changes without creating a second task", async (t) => {
  const f = await fixture(t);
  const first = await f.service.register(registration(), ACTOR);
  f.values.record.instruction = "changed after registration";
  f.values.active.lifecycle = "disabled";
  const replay = await f.create().register(registration(), ACTOR);
  assert.equal(replay.created, false);
  assert.equal(replay.task.id, first.task.id);
  assert.equal(f.values.reads, 1);
  assert.equal(f.database.listFeishuTasks().length, 1);
  await assert.rejects(() => f.service.register(registration({ event: { recordId: "rec_other" } }), ACTOR),
    { code: "FEISHU_EVENT_BINDING_CONFLICT" });
});

test("parallel duplicate deliveries reserve only one DB event identity", async (t) => {
  const f = await fixture(t);
  const results = await Promise.all([f.service.register(registration(), ACTOR), f.service.register(registration(), ACTOR)]);
  assert.equal(new Set(results.map(({ task }) => task.id)).size, 1);
  assert.equal(results.filter(({ created }) => created).length, 1);
});

test("simulation, caller-controlled values and non-initial stages cannot register", async (t) => {
  const f = await fixture(t);
  for (const body of [registration({ event: { deliverySource: "simulation" } }),
    { ...registration(), controlledContext: { vmid: VMID } },
    { ...registration(), workspacePath: "C:\\untrusted" }, registration({ binding: { stageId: "review" } })]) {
    await assert.rejects(() => f.service.register(body, ACTOR), (error) => error.status === 400 || error.status === 409);
  }
  assert.equal(f.values.reads, 0);
  assert.equal(f.database.listFeishuTasks().length, 0);
});

test("stale configuration, untrusted package and invalid edges fail closed", async (t) => {
  const f = await fixture(t);
  for (const mutate of [
    (v) => { v.active.lifecycle = "disabled"; },
    (v) => { v.active.configVersion = 5; },
    (v) => { v.active.vmWorkflow.stages.review.enabled = true; },
    (v) => { v.frozen.closedAt = 300; },
    (v) => { v.package.state = "draft"; },
    (v) => { v.package.workflowTemplate = { id: "document_draft_zip", version: 1 }; },
    (v) => { v.package.alias = "other"; },
  ]) {
    const backup = structuredClone(f.values); mutate(f.values);
    await assert.rejects(() => f.service.register(registration(), ACTOR), (error) => error.status === 409);
    Object.assign(f.values, backup);
  }
  for (const event of [{ beforeOptionId: "opt_initial" }, { beforeOptionId: "opt_missing" },
    { afterOptionId: "opt_other" }, { statusFieldId: "fld_other" }, { occurredAt: 99 }]) {
    await assert.rejects(() => f.service.register(registration({ event }), ACTOR), (error) => error.status === 409);
  }
  assert.equal(f.database.listFeishuTasks().length, 0);
});

test("changed PMO status, missing values and unsafe VM IDs prevent creation", async (t) => {
  const f = await fixture(t);
  for (const patch of [{ statusOptionId: "opt_other" }, { vmid: "C:\\source.mp4" }, { vmid: "" },
    { title: "" }, { instruction: "" }, { instruction: "bad\0instruction" }]) {
    const backup = structuredClone(f.values.record); Object.assign(f.values.record, patch);
    await assert.rejects(() => f.service.register(registration(), ACTOR), (error) => error.status === 409);
    f.values.record = backup;
  }
  assert.equal(f.database.listFeishuTasks().length, 0);
});

test("disable while reading PMO is rechecked before the database write", async (t) => {
  const f = await fixture(t);
  const service = createVmTaskRegistration({ database: f.database,
    getActiveSubject: async () => f.values.active, getPackage: async () => f.values.package,
    readCurrentRecord: async () => { f.values.active.lifecycle = "disabled"; return f.values.record; } });
  await assert.rejects(() => service.register(registration(), ACTOR), { code: "STALE_STAGE_EVENT" });
  assert.equal(f.database.listFeishuTasks().length, 0);
});

test("reader resolves exact frozen field IDs using live metadata and safely extracts text", async () => {
  const snapshot = subject();
  const liveFields = snapshot.metadata.fields.map((field) => ({ field_id: field.fieldId, field_name: field.fieldName,
    type: field.type, ui_type: field.uiType, property: { options: field.options } }));
  const fields = { 制作进度: "待剪辑", 原视频vmid: [{ type: "text", text: VMID }],
    名称: "化学变化中微粒怎么变？", 初稿意见: [{ text: "仅保留 " }, { text: "00:00–00:20" }] };
  const reader = createVmRegistrationRecordReader({ listFields: async () => liveFields, getRecord: async () => ({ fields }) });
  assert.deepEqual(await reader({ subject: snapshot, event: registration().event }), {
    vmid: VMID, title: "化学变化中微粒怎么变？", instruction: "仅保留 00:00–00:20", statusOptionId: "opt_initial" });
  fields.fld_vmid = "different";
  await assert.rejects(() => reader({ subject: snapshot, event: registration().event }), { code: "VM_RECORD_INVALID" });
  delete fields.fld_vmid;
  liveFields[1].field_name = "已改名";
  await assert.rejects(() => reader({ subject: snapshot, event: registration().event }), { code: "VM_FIELD_BINDING_CHANGED" });
});

test("canonical value-based status options and ISO enabled timestamps are supported", async (t) => {
  const f = await fixture(t);
  for (const snapshot of [f.values.active, f.values.frozen]) {
    snapshot.statusField.options = snapshot.statusField.options.map(({ optionId, name }) => ({ optionId, value: name }));
    snapshot.enabledAt = new Date(100).toISOString();
  }
  await assert.rejects(() => f.service.register(registration({ event: { occurredAt: 99 } }), ACTOR), { code: "STALE_STAGE_EVENT" });
  const registered = await f.service.register(registration(), ACTOR);
  assert.equal(registered.origin.triggerValue, "待剪辑");
  const reader = createVmRegistrationRecordReader({ listFields: async () => f.values.frozen.metadata.fields,
    getRecord: async () => ({ fields: { fld_status: "待剪辑", fld_vmid: VMID, fld_name: "测试", fld_instruction: "保留00:00–00:20" } }) });
  assert.equal((await reader({ subject: f.values.frozen, event: registration().event })).statusOptionId, "opt_initial");
});
