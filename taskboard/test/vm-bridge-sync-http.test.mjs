import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createWorkflowConfigStore } from "../../src/workflow-config-store.mjs";
import { createTaskboardServer } from "../server/app.mjs";

test("VM activation sends its naming field and numeric timestamps to Bridge", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vm-bridge-sync-"));
  const received = [];
  const bridgeStore = createWorkflowConfigStore({ filename: path.join(directory, "bridge-workflow.json"),
    initial: { schemaVersion: 1, configVersion: 1, bases: [] }, packageAliases: ["vm"] });
  const bridge = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    received.push({ path: request.url, body });
    try {
      const subject = await bridgeStore.syncSubject(body.subject, { lifecycle: body.lifecycle,
        expectedVersion: body.expectedVersion });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ subject }));
    } catch (error) {
      response.writeHead(409, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: error.code ?? "INVALID_FIELD" } }));
    }
  });
  await new Promise((resolve) => bridge.listen(0, "127.0.0.1", resolve));
  const record = { alias: "vm", state: "enabled", workflowTemplate: { id: "vm_pmo_review_video", version: 1 } };
  const app = createTaskboardServer({ dataDirectory: directory, processEnv: {},
    feishuBridgeUrl: `http://127.0.0.1:${bridge.address().port}`,
    feishuPackageStore: { get: async () => record, list: async () => [record] },
    vmPmoRuntime: { ready: async () => ({ available: true }), validateActivation: async () => true,
      start: async () => {}, close: async () => {} },
  });
  t.after(async () => { await app.close(); await new Promise((resolve) => bridge.close(resolve));
    await rm(directory, { recursive: true, force: true }); });
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const request = async (route, method = "GET", body = undefined) => {
    const response = await fetch(`${baseUrl}${route}`, { method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const key = "bas_vm:tbl_vm";
  const catalog = await request("/api/local/feishu/workflow/catalog", "POST", {
    baseToken: "bas_vm", baseName: "课程库", tables: [{ tableId: "tbl_vm", tableName: "数学", fields: [
      { fieldId: "fld_vmid", fieldName: "VMID", type: 1, uiType: "Text", options: [] },
      { fieldId: "fld_name", fieldName: "视频名称", type: 1, uiType: "Text", options: [] },
      { fieldId: "fld_instruction", fieldName: "初稿意见", type: 1, uiType: "Text", options: [] },
      { fieldId: "fld_output", fieldName: "成片", type: 17, uiType: "Attachment", options: [] },
      { fieldId: "fld_status", fieldName: "状态", type: 3, uiType: "SingleSelect", options: [
        { id: "opt_other", name: "准备" }, { id: "opt_initial", name: "待剪辑" },
        { id: "opt_processing", name: "处理中" }, { id: "opt_completed", name: "完成" },
      ] },
    ] }] });
  assert.equal(catalog.status, 201);
  const route = `/api/local/feishu/subjects/${encodeURIComponent(key)}/package-workflow-drafts/vm`;
  const draft = await request(route);
  assert.equal(draft.status, 200);
  const config = { ...draft.body.config,
    fields: { vmidFieldId: "fld_vmid", namingFieldId: "fld_name", outputAttachmentFieldId: "fld_output" },
    approval: { department: "课程", reason: "制作初稿" },
    stages: { ...draft.body.config.stages, initial: { ...draft.body.config.stages.initial,
      enabled: true, statusFieldId: "fld_status", triggerOptionId: "opt_initial", instructionFieldId: "fld_instruction",
      writeback: { processing: { fieldId: "fld_status", optionId: "opt_processing" },
        completed: { fieldId: "fld_status", optionId: "opt_completed" } },
    } },
    finalArchive: { ...draft.body.config.finalArchive, directoryPath: "C:\\vm-pmo\\private" },
  };
  const saved = await request(route, "PUT", { expectedRevision: draft.body.revision, config });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const subject = await request(`/api/local/feishu/workflow/subjects/${encodeURIComponent(key)}`);
  const enabled = await request(`${route}/enable`, "POST", {
    expectedRevision: saved.body.revision, expectedVersion: subject.body.subject.configVersion });
  assert.equal(enabled.status, 200, JSON.stringify(enabled.body));
  assert.equal(received.length, 1);
  assert.equal(received[0].path, "/api/feishu/workflow/sync");
  assert.deepEqual(received[0].body.subject.title, { fieldId: "fld_name", fieldName: "视频名称" });
  assert.equal(typeof received[0].body.subject.createdAt, "number");
  assert.equal(typeof received[0].body.subject.updatedAt, "number");
  assert.equal(received[0].body.subject.upload, undefined);
  assert.equal(received[0].body.subject.vmWorkflow.finalArchive.directoryPath, null);
  const persisted = (await bridgeStore.read()).bases[0].subjects[0];
  assert.deepEqual(persisted.workflowTemplate, { id: "vm_pmo_review_video", version: 1 });
  assert.deepEqual(persisted.title, { fieldId: "fld_name", fieldName: "视频名称" });
  assert.equal(persisted.vmWorkflow.stages.initial.triggerOptionId, "opt_initial");
  assert.equal(persisted.upload, undefined);
  assert.equal(persisted.vmWorkflow.finalArchive.directoryPath, null);
  assert.equal(enabled.body.subject.vmWorkflow.finalArchive.directoryPath, "C:\\vm-pmo\\private");
});
