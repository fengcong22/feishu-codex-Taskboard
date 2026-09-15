import assert from "node:assert/strict";
import test from "node:test";

import { decideRecordChange } from "../src/decide-event.mjs";
import { normalizeBitableRecordChanged } from "../src/feishu-event.mjs";
import {
  buildTrustedTaskPayload,
} from "../src/task-payload.mjs";
import {
  createFeishuControlledContextReader,
  createFeishuNamingSearch,
  readControlledRecordContext,
} from "../src/feishu-record-reader.mjs";
import { createBridgeServer } from "../src/server.mjs";
import { createBridge } from "../src/bridge.mjs";
import { JsonStateStore } from "../src/state-store.mjs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const subject = {
  subjectKey: "bas_demo:tbl_math",
  configVersion: 7,
  lifecycle: "enabled",
  baseToken: "bas_demo",
  tableId: "tbl_math",
  tableName: "数学",
  statusField: { fieldId: "fld_status", fieldName: "制作进度" },
  documentField: { fieldId: "fld_document", fieldName: "集合文档" },
  namingField: { fieldId: "fld_name", fieldName: "命名" },
  stages: {
    initial: {
      enabled: true,
      trigger: { fieldId: "fld_status", optionId: "opt_initial", value: "待初稿" },
      videoSource: { kind: "docx_section", anchorText: "录屏" },
      reviewSource: { kind: "docx_section", anchorText: "修改意见" },
      audio: { mode: "video_original" },
      nameSuffix: "_初稿",
    },
    first_review: {
      enabled: true,
      trigger: { fieldId: "fld_status", optionId: "opt_first", value: "待初审修改" },
      videoSource: { kind: "docx_section", anchorText: "初审视频" },
      reviewSource: { kind: "docx_section", anchorText: "初审意见" },
      audio: { mode: "video_original" },
      nameSuffix: "_初审修改",
    },
    final_review: {
      enabled: false,
      trigger: { fieldId: "fld_status", optionId: "opt_final", value: "待终审修改" },
      videoSource: { kind: "docx_section", anchorText: "终审视频" },
      reviewSource: { kind: "docx_section", anchorText: "终审意见" },
      audio: { mode: "video_original" },
      nameSuffix: "_终审修改",
    },
  },
  execution: { mode: "automatic", enqueueMode: "automatic" },
  packageRoute: { packageAlias: "Auto-cut-lite" },
  upload: { enqueueMode: "automatic" },
};

function edge(beforeOptionId, afterOptionId, overrides = {}) {
  return {
    eventId: "evt-1",
    baseToken: "bas_demo",
    tableId: "tbl_math",
    recordId: "rec-1",
    recordTitle: "第一课",
    statusFieldId: "fld_status",
    fieldId: "fld_status",
    fieldName: "制作进度",
    beforePresent: true,
    afterPresent: true,
    beforeOptionId,
    afterOptionId,
    beforeValue: beforeOptionId,
    afterValue: afterOptionId,
    eventOccurredAt: 1500,
    eventOccurredAtPresent: true,
    fields: {},
    fieldValuesById: {},
    ...overrides,
  };
}

async function readDocumentLinks(documentFieldValue) {
  const get = async () => ({
    code: 0,
    data: { record: { fields: { 集合文档: documentFieldValue } } },
  });
  const reader = createFeishuControlledContextReader({
    client: {
      bitable: { v1: { appTableRecord: { get } } },
    },
  });
  const result = await reader.read(subject, {
    baseToken: "bas_demo",
    tableId: "tbl_math",
    recordId: "rec-1",
  });
  return result.documentLinks;
}

test("registers only a non-target to enabled stage target edge", () => {
  const result = decideRecordChange(subject, edge("opt_other", "opt_initial"));
  assert.equal(result.kind, "register");
  assert.equal(result.stageId, "initial");
  assert.equal(result.archiveWaiting, false);
  assert.equal(decideRecordChange(subject, edge("opt_initial", "opt_initial")).kind, "ignored");
});

test("archives the old stage before registering a stage-to-stage move", () => {
  const result = decideRecordChange(subject, edge("opt_initial", "opt_first"));
  assert.equal(result.kind, "register");
  assert.equal(result.stageId, "first_review");
  assert.equal(result.archiveWaiting, true);
  assert.equal(result.previousStageId, "initial");
});

test("fails closed when either side of the status edge is absent", () => {
  const result = decideRecordChange(subject, { ...edge("opt_other", "opt_initial"), beforePresent: false });
  assert.deepEqual({ kind: result.kind, reasonCode: result.reasonCode }, {
    kind: "blocked",
    reasonCode: "MISSING_STATUS_EDGE",
  });
});

test("normalizes option ids and provider occurrence time without erasing presence", () => {
  const payload = {
    header: { event_id: "evt-provider" },
    event: {
      file_token: "bas_demo",
      table_id: "tbl_math",
      record_id: "rec-1",
      create_time: 1788652800000,
      action_list: [{
        action: "record_edited",
        before_value: [{ field_id: "fld_status", field_value: JSON.stringify("opt_other") }],
        after_value: [{ field_id: "fld_status", field_value: JSON.stringify("opt_initial") }],
      }],
    },
  };
  const [event] = normalizeBitableRecordChanged(payload, {
    ...subject,
    triggerField: "制作进度",
    triggerFieldId: "fld_status",
    triggerValue: "待初稿",
    triggerOptionId: "opt_initial",
  });
  assert.equal(event.beforePresent, true);
  assert.equal(event.afterPresent, true);
  assert.equal(event.beforeOptionId, "opt_other");
  assert.equal(event.afterOptionId, "opt_initial");
  assert.equal(event.statusFieldId, "fld_status");
  assert.equal(event.eventOccurredAt, 1788652800000);
  assert.equal(event.eventOccurredAtPresent, true);
});

test("controlled context reads only configured fields and retains invalid values as data", async () => {
  const calls = [];
  const reader = createFeishuControlledContextReader({
    client: {
      bitable: { v1: { appTableRecord: { get: async (request) => {
        calls.push(request);
        return { code: 0, data: { record: { fields: {
          集合文档: ["https://guanghe.feishu.cn/docx/one", "https://guanghe.feishu.cn/docx/two"],
          命名: "",
        } } } };
      } } } },
    },
    searchNaming: async () => ({ provedUnique: false }),
  });
  const result = await readControlledRecordContext(reader, {
    ...subject,
    documentField: { fieldId: "fld_document", fieldName: "集合文档" },
    namingField: { fieldId: "fld_name", fieldName: "命名" },
  }, { baseToken: "bas_demo", tableId: "tbl_math", recordId: "rec-1" });
  assert.deepEqual(result.documentLinks, [
    "https://guanghe.feishu.cn/docx/one",
    "https://guanghe.feishu.cn/docx/two",
  ]);
  assert.equal(result.namingDisplayValue, "");
  assert.equal(result.namingValueUnique, false);
  assert.equal(calls[0].path.record_id, "rec-1");
  assert.deepEqual(calls[0].params, { text_field_as_array: true });
});

test("controlled context accepts the configured record's trusted Feishu Wiki link", async () => {
  const wikiUrl = "https://guanghe.feishu.cn/wiki/UCMRdeXEUobqXoxG1zvcT3a2nId";
  assert.deepEqual(await readDocumentLinks(wikiUrl), [wikiUrl]);
});

test("controlled context requests structured text so Docx mentions retain their link", async () => {
  const docxUrl = "https://guanghe.feishu.cn/docx/UlB9d4x5loey36xW3zMcnjC7nFb";
  const calls = [];
  const reader = createFeishuControlledContextReader({
    client: {
      bitable: { v1: { appTableRecord: { get: async (request) => {
        calls.push(request);
        const value = request.params?.text_field_as_array === true
          ? [{ type: "mention", mentionType: "Docx", text: "课程文档", link: docxUrl }]
          : "课程文档";
        return { code: 0, data: { record: { fields: { 集合文档: value } } } };
      } } } },
    },
  });

  const result = await reader.read(subject, {
    baseToken: "bas_demo",
    tableId: "tbl_math",
    recordId: "rec-1",
  });

  assert.deepEqual(result.documentLinks, [docxUrl]);
  assert.deepEqual(calls[0].params, { text_field_as_array: true });
});

test("controlled context strips Feishu's Base navigation hint from a trusted Wiki link", async () => {
  const wikiUrl = "https://guanghe.feishu.cn/wiki/D4mIwGfEviHFPjkht6ic1iManzh";
  const baseCellUrl = `${wikiUrl}?pre_pathname=%2Fdrive%2Fhome%2Frecents%2F`;
  assert.deepEqual(await readDocumentLinks(baseCellUrl), [wikiUrl]);
});

test("controlled context accepts only exact credential-free Feishu Docx or Wiki links", async () => {
  assert.deepEqual(await readDocumentLinks([
    "https://guanghe.feishu.cn/docx/DocxToken_1-2",
    "https://feishu.cn/wiki/WikiToken_1-2",
    "https://user:secret@guanghe.feishu.cn/docx/Credentials",
    "https://@guanghe.feishu.cn/docx/EmptyCredentials",
    "https://guanghe.feishu.cn/docx/Query?download=1",
    "https://guanghe.feishu.cn/docx/EmptyQuery?",
    "https://guanghe.feishu.cn/docx/Fragment#section",
    "https://guanghe.feishu.cn/docx/EmptyFragment#",
    "https://guanghe.feishu.cn/wiki/Extra/path",
    "https://guanghe.feishu.cn/wiki/Extra/../NormalizedAway",
    "https://guanghe.feishu.cn\\ignored/wiki/BackslashNormalizedAway",
    "HTTPS://guanghe.feishu.cn/wiki/UppercaseScheme",
    "https://GUANGHE.FEISHU.CN/wiki/UppercaseHost",
    "https://guanghe.feishu.cn/wiki/_InvalidFirstCharacter",
    "https://guanghe.feishu.cn/wiki/Invalid.Token",
    "http://guanghe.feishu.cn/wiki/Insecure",
    "https://guanghe.feishu.cn.evil.example/wiki/WrongHost",
    "https://example.com/docx/WrongHost",
  ]), [
    "https://guanghe.feishu.cn/docx/DocxToken_1-2",
    "https://feishu.cn/wiki/WikiToken_1-2",
  ]);
});

test("naming search proves uniqueness with an exact Base filter and bounded results", async () => {
  const calls = [];
  const searchNaming = createFeishuNamingSearch({
    client: {
      bitable: { v1: { appTableRecord: { search: async (request) => {
        calls.push(request);
        return {
          code: 0,
          data: {
            items: [{ record_id: "rec-1" }],
            has_more: false,
          },
        };
      } } } },
    },
  });
  assert.equal(typeof searchNaming, "function");
  const proof = await searchNaming({
    baseToken: "bas_demo",
    tableId: "tbl_math",
    recordId: "rec-1",
    fieldId: "fld_name",
    fieldName: "命名",
    value: "课程001",
  });
  assert.deepEqual(proof, { records: [{ record_id: "rec-1" }] });
  assert.deepEqual(calls, [{
    path: { app_token: "bas_demo", table_id: "tbl_math" },
    data: {
      field_names: ["命名"],
      filter: {
        conjunction: "and",
        conditions: [{ field_name: "命名", operator: "is", value: ["课程001"] }],
      },
    },
    params: { page_size: 2 },
  }]);
});

test("naming search scans formula results exactly when Feishu filtering returns no rows", async () => {
  const calls = [];
  const searchNaming = createFeishuNamingSearch({
    client: {
      bitable: { v1: { appTableRecord: { search: async (request) => {
        calls.push(request);
        if (request.data.filter) {
          return { code: 0, data: { items: [], has_more: false } };
        }
        if (!request.params.page_token) {
          return {
            code: 0,
            data: {
              items: [
                { record_id: "rec-1", fields: { 命名: [{ text: "课程001" }] } },
                { record_id: "rec-2", fields: { 命名: [{ text: "课程002" }] } },
              ],
              has_more: true,
              page_token: "page-2",
            },
          };
        }
        return {
          code: 0,
          data: {
            items: [{ record_id: "rec-3", fields: { 命名: [{ text: "课程003" }] } }],
            has_more: false,
          },
        };
      } } } },
    },
  });
  const proof = await searchNaming({
    baseToken: "bas_demo",
    tableId: "tbl_math",
    recordId: "rec-1",
    fieldId: "fld_name",
    fieldName: "命名",
    value: "课程001",
  });
  assert.deepEqual(proof.records.map((record) => record.record_id), ["rec-1"]);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[1], {
    path: { app_token: "bas_demo", table_id: "tbl_math" },
    data: { field_names: ["命名"] },
    params: { page_size: 500 },
  });
  assert.equal(calls[2].params.page_token, "page-2");
});

test("controlled context proves naming uniqueness only for the requested record", async () => {
  async function readWithProof(records) {
    const reader = createFeishuControlledContextReader({
      client: {
        bitable: { v1: { appTableRecord: { get: async () => ({
          code: 0,
          data: { record: { fields: {
            集合文档: "https://guanghe.feishu.cn/docx/one",
            命名: "课程001",
          } } },
        }) } } } },
      searchNaming: async () => ({ records }),
    });
    return reader.read(subject, {
      baseToken: "bas_demo",
      tableId: "tbl_math",
      recordId: "rec-1",
    });
  }

  assert.equal((await readWithProof([{ record_id: "rec-other" }])).namingValueUnique, false);
  assert.equal((await readWithProof([{ record_id: "rec-1" }])).namingValueUnique, true);
  assert.equal((await readWithProof([
    { record_id: "rec-1" },
    { record_id: "rec-other" },
  ])).namingValueUnique, false);
});

test("index wires the Feishu naming search into controlled-context reads", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../src/index.mjs", import.meta.url), "utf8");
  assert.match(source, /createFeishuNamingSearch/);
  assert.match(source, /searchNaming\s*:/);
});

test("index can enable read-only Feishu APIs without starting the WebSocket listener", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../src/index.mjs", import.meta.url), "utf8");
  assert.match(source, /FEISHU_READ_ENABLED/);
  assert.match(source, /const sdk = apiEnabled \? await loadFeishuSdk\(\) : null/);
  assert.ok(
    source.indexOf("controlledContextReader = createFeishuControlledContextReader")
      < source.lastIndexOf("if (listenerEnabled)"),
  );
});

test("index shares the Feishu metadata reader with workflow validation and Base preview", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../src/index.mjs", import.meta.url), "utf8");
  assert.match(source, /createFeishuBaseMetadataReader/);
  assert.match(
    source,
    /createWorkflowRuntime\(\{\s*config,\s*store: workflowStore,\s*metadataReader,\s*\}\)/,
  );
  assert.match(source, /createBridgeServer\(\{[\s\S]*?\n\s*metadataReader,/);
});

test("trusted task payload contains binding and context but no executable path", () => {
  const payload = buildTrustedTaskPayload({
    kind: "register",
    subject,
    stageId: "initial",
    configVersion: 7,
    packageAlias: "Auto-cut-lite",
    event: edge("opt_other", "opt_initial"),
  }, {
    documentLinks: ["https://guanghe.feishu.cn/docx/one"],
    namingDisplayValue: "课程001",
    namingValueUnique: true,
  });
  assert.equal(payload.binding.stageId, "initial");
  assert.equal(payload.controlledContext.namingDisplayValue, "课程001");
  assert.equal(Object.hasOwn(payload, "workspacePath"), false);
  assert.equal(Object.hasOwn(payload, "prompt"), false);
  assert.equal(Object.hasOwn(payload, "artifactTargetPath"), false);
});

test("trusted phased payload preserves server-owned simulation provenance", () => {
  const payload = buildTrustedTaskPayload({
    kind: "register",
    subject,
    stageId: "initial",
    configVersion: 7,
    packageAlias: "Auto-cut-lite",
    event: { ...edge("opt_other", "opt_initial"), deliverySource: "simulation" },
  }, {
    documentLinks: [],
    namingDisplayValue: "课程001",
    namingValueUnique: true,
  });
  assert.equal(payload.event.deliverySource, "simulation");
});

test("rehydrated ambiguous phased events remain manual-only in registration payloads", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "feishu-phased-provenance-"));
  const filename = path.join(dir, "state.json");
  const eventId = "evt-phased-ambiguous-replay";
  await writeFile(filename, JSON.stringify({
    [eventId]: {
      schemaVersion: 2,
      eventId,
      event: null,
      deliveryProvenance: { version: 1, source: "simulation" },
      deliveryState: "dead_letter",
      decision: null,
      decisionSnapshot: null,
      attempts: 1,
      nextAttemptAt: null,
      lease: null,
      lastError: { code: "EVENT_SNAPSHOT_MISSING", status: 0, at: 0 },
      failureHistory: [],
      outcome: null,
      createdAt: 0,
      updatedAt: 0,
    },
  }));
  let registration;
  const bridge = createBridge({
    config: {
      delivery: { maxAttempts: 2, initialDelayMs: 5, maxDelayMs: 5, leaseMs: 1000, pollIntervalMs: 100 },
      tables: [subject],
      packages: { "Auto-cut-lite": { projectId: "p", projectName: "p", workspacePath: "D:\\trusted", prompt: "fixed" } },
    },
    store: new JsonStateStore(filename),
    workflowStore: { resolveSubjectVersionAt: async () => subject },
    readControlledContext: async () => ({
      documentLinks: [], namingDisplayValue: "课程001", namingValueUnique: true,
    }),
    taskboard: {
      registerFeishuStageTask: async (payload) => {
        registration = payload;
        return { id: "task-ambiguous", identifier: "FEI-AMBIGUOUS" };
      },
    },
  });

  const result = await bridge.handle(edge("opt_other", "opt_initial", { eventId }));
  assert.equal(result.kind, "register");
  assert.equal(registration.event.deliverySource, "simulation");
});

test("controlled context endpoint requires Taskboard identity and shared secret", async (t) => {
  const app = createBridgeServer({
    host: "127.0.0.1",
    port: 0,
    bridgeSecret: "bridge-secret",
    getSubjectVersion: async (key, version) => key === subject.subjectKey && version === 7 ? subject : null,
    readControlledContext: async () => ({
      documentLinks: [], namingDisplayValue: "课程001", namingValueUnique: true,
    }),
  });
  const address = await app.listen();
  t.after(app.close);
  const body = {
    subjectKey: subject.subjectKey,
    configVersion: 7,
    baseToken: "bas_demo",
    tableId: "tbl_math",
    recordId: "rec-1",
  };
  const denied = await fetch(`http://127.0.0.1:${address.port}/api/feishu/workflow/controlled-context`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  assert.equal(denied.status, 403);
  const allowed = await fetch(`http://127.0.0.1:${address.port}/api/feishu/workflow/controlled-context`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-feishu-bridge-client": "taskboard",
      "x-feishu-bridge-secret": "bridge-secret",
    },
    body: JSON.stringify(body),
  });
  assert.equal(allowed.status, 200);
  assert.deepEqual(await allowed.json(), {
    documentLinks: [], namingDisplayValue: "课程001", namingValueUnique: true,
  });
});

test("workflow sync returns a portable subject and never echoes local destinations", async (t) => {
  const app = createBridgeServer({
    host: "127.0.0.1",
    port: 0,
    bridgeSecret: "bridge-secret",
    syncSubject: async (value) => value,
  });
  const address = await app.listen();
  t.after(app.close);
  const response = await fetch(`http://127.0.0.1:${address.port}/api/feishu/workflow/sync`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-feishu-bridge-client": "taskboard",
      "x-feishu-bridge-secret": "bridge-secret",
    },
    body: JSON.stringify({
      lifecycle: "enabled",
      expectedVersion: 1,
      subject: {
        subjectKey: subject.subjectKey,
        configVersion: 7,
        baseToken: subject.baseToken,
        tableId: subject.tableId,
        stages: {
          initial: {
            artifactTargetPath: "D:\\private\\camel",
            artifact_target_path: "D:\\private\\snake",
          },
        },
      },
    }),
  });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.subject.stages?.initial?.artifactTargetPath, undefined);
  assert.equal(body.subject.stages?.initial?.artifact_target_path, undefined);
  assert.doesNotMatch(JSON.stringify(body), /D:\\\\private/u);
});

test("registers a phased task through the dedicated route after archiving the prior stage", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "feishu-phased-bridge-"));
  const order = [];
  const bridge = createBridge({
    config: {
      delivery: { maxAttempts: 2, initialDelayMs: 5, maxDelayMs: 5, leaseMs: 1000, pollIntervalMs: 100 },
      tables: [subject],
      packages: { "Auto-cut-lite": { projectId: "p", projectName: "p", workspacePath: "D:\\trusted", prompt: "fixed" } },
    },
    store: new JsonStateStore(path.join(dir, "state.json")),
    workflowStore: { resolveSubjectVersionAt: async () => subject },
    readControlledContext: async () => ({ documentLinks: ["https://guanghe.feishu.cn/docx/one"], namingDisplayValue: "课程001", namingValueUnique: true }),
    taskboard: {
      listFeishuTasks: async () => [],
      registerFeishuStageTask: async (payload) => { order.push(`register:${payload.binding.stageId}`); return { id: "task-1", identifier: "FEI-1" }; },
    },
  });
  const result = await bridge.handle(edge("opt_initial", "opt_first", { eventId: "evt-move" }));
  assert.equal(result.kind, "register");
  assert.deepEqual(order, ["register:first_review"]);
});

test("blocks a phased event when no active configuration version can be proven", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "feishu-phased-missing-version-"));
  let registrations = 0;
  const store = new JsonStateStore(path.join(dir, "state.json"));
  const bridge = createBridge({
    config: {
      delivery: { maxAttempts: 2, initialDelayMs: 5, maxDelayMs: 5, leaseMs: 1000, pollIntervalMs: 100 },
      tables: [subject],
      packages: { "Auto-cut-lite": { projectId: "p", projectName: "p", workspacePath: "D:\\trusted", prompt: "fixed" } },
    },
    store,
    workflowStore: { resolveSubjectVersionAt: async () => null },
    taskboard: {
      registerFeishuStageTask: async () => {
        registrations += 1;
        return { id: "task-1", identifier: "FEI-1" };
      },
    },
  });

  const result = await bridge.handle(edge("opt_other", "opt_initial", {
    eventId: "evt-missing-active-version",
    eventOccurredAt: 1500,
  }));

  assert.equal(result.kind, "blocked");
  assert.equal(result.reasonCode, "MISSING_ACTIVE_CONFIG_VERSION");
  assert.equal(registrations, 0);
  const record = await store.get("evt-missing-active-version");
  assert.equal(record.deliveryState, "succeeded");
  assert.equal(record.outcome.reasonCode, "MISSING_ACTIVE_CONFIG_VERSION");
});

test("archives a previous stage when the new target stage is disabled", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "feishu-phased-bridge-"));
  const order = [];
  const waiting = {
    id: "task-old",
    identifier: "FEI-OLD",
    version: 3,
    status: "todo",
    archivedAt: null,
    feishuOrigin: {
      baseToken: "bas_demo",
      tableId: "tbl_math",
      recordId: "rec-1",
      statusFieldId: "fld_status",
      stageId: "initial",
    },
  };
  const disabledFinal = structuredClone(subject);
  disabledFinal.stages.final_review.enabled = false;
  const bridge = createBridge({
    config: {
      delivery: { maxAttempts: 2, initialDelayMs: 5, maxDelayMs: 5, leaseMs: 1000, pollIntervalMs: 100 },
      tables: [disabledFinal],
      packages: { "Auto-cut-lite": { projectId: "p", projectName: "p", workspacePath: "D:\\trusted", prompt: "fixed" } },
    },
    store: new JsonStateStore(path.join(dir, "state.json")),
    workflowStore: { resolveSubjectVersionAt: async () => disabledFinal },
    taskboard: {
      listFeishuTasks: async () => [waiting],
      getTask: async () => waiting,
      archiveFeishuTask: async () => { order.push("archive"); return { ...waiting, archivedAt: new Date().toISOString() }; },
      registerFeishuStageTask: async () => { order.push("register"); return { id: "new", identifier: "FEI-NEW" }; },
    },
  });
  const result = await bridge.handle(edge("opt_initial", "opt_final", { eventId: "evt-disabled-target" }));
  assert.equal(result.kind, "ignored");
  assert.deepEqual(order, ["archive"]);
});

const [unrelatedFieldEvent] = normalizeBitableRecordChanged({
  header: { event_id: "evt-unrelated-field" },
  event: {
    file_token: "bas_demo",
    table_id: "tbl_math",
    record_id: "rec-1",
    create_time: 1788652800000,
    action_list: [{
      action: "record_edited",
      field_name: "备注",
      before_value: [{ field_id: "fld_notes", field_value: JSON.stringify("旧备注") }],
      after_value: [{ field_id: "fld_notes", field_value: JSON.stringify("新备注") }],
    }],
  },
}, {
  ...subject,
  triggerField: "制作进度",
  triggerFieldId: "fld_status",
  triggerValue: "待初稿",
  triggerOptionId: "opt_initial",
});

for (const [name, event, expected] of [
  ["the record remains in the same stage", edge("opt_initial", "opt_initial", {
    eventId: "evt-same-stage",
  }), { kind: "ignored", reason: "already_at_trigger" }],
  ["an unrelated field changes", unrelatedFieldEvent, {
    kind: "ignored",
    reason: "unrelated_field",
  }],
]) {
  test(`does not archive a waiting phased task when ${name}`, async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "feishu-phased-noop-"));
    let taskboardCalls = 0;
    const bridge = createBridge({
      config: {
        delivery: { maxAttempts: 2, initialDelayMs: 5, maxDelayMs: 5, leaseMs: 1000, pollIntervalMs: 100 },
        tables: [subject],
        packages: { "Auto-cut-lite": { projectId: "p", projectName: "p", workspacePath: "D:\\trusted", prompt: "fixed" } },
      },
      store: new JsonStateStore(path.join(dir, "state.json")),
      workflowStore: { resolveSubjectVersionAt: async () => subject },
      taskboard: {
        listFeishuTasks: async () => { taskboardCalls += 1; return []; },
        getTask: async () => { taskboardCalls += 1; return null; },
        archiveFeishuTask: async () => { taskboardCalls += 1; return null; },
        registerFeishuStageTask: async () => { taskboardCalls += 1; return null; },
      },
    });

    const result = await bridge.handle(event);

    assert.deepEqual(result, expected);
    assert.equal(taskboardCalls, 0);
  });
}

test("retries a phased registration from its persisted subject and context snapshot", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "feishu-phased-bridge-"));
  const filename = path.join(dir, "state.json");
  const retrySubject = structuredClone(subject);
  retrySubject.stages.initial.artifact_target_path = "D:\\private\\decision-snapshot";
  let resolveCalls = 0;
  let contextCalls = 0;
  let registerCalls = 0;
  let clock = 1000;
  const bridge = createBridge({
    config: {
      delivery: { maxAttempts: 3, initialDelayMs: 5, maxDelayMs: 5, leaseMs: 1000, pollIntervalMs: 100 },
      tables: [retrySubject],
      packages: { "Auto-cut-lite": { projectId: "p", projectName: "p", workspacePath: "D:\\trusted", prompt: "fixed" } },
    },
    store: new JsonStateStore(filename),
    workflowStore: {
      resolveSubjectVersionAt: async () => { resolveCalls += 1; return retrySubject; },
    },
    readControlledContext: async () => { contextCalls += 1; return { documentLinks: ["https://guanghe.feishu.cn/docx/one"], namingDisplayValue: "课程001", namingValueUnique: true }; },
    taskboard: {
      registerFeishuStageTask: async () => {
        registerCalls += 1;
        if (registerCalls === 1) throw Object.assign(new Error("temporary"), { code: "TASKBOARD_UNAVAILABLE" });
        return { id: "task-1", identifier: "FEI-1" };
      },
    },
    random: () => 0.5,
    now: () => clock,
  });
  const first = await bridge.handle(edge("opt_other", "opt_initial", { eventId: "evt-retry" }));
  assert.equal(first.kind, "pending");
  const persisted = await readFile(filename, "utf8");
  assert.doesNotMatch(persisted, /artifact_target_path|decision-snapshot/u);
  // The event is due immediately in this fixture; processDue claims the same
  // persisted record without resolving the current workflow again.
  clock = 2000;
  const second = await bridge.processDue();
  assert.equal(second.kind, "register");
  assert.equal(resolveCalls, 1);
  assert.equal(contextCalls, 1);
  assert.equal(registerCalls, 2);
});
