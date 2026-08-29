import assert from "node:assert/strict";
import test from "node:test";

import { createWorkflowRuntime } from "../src/workflow-runtime.mjs";

const legacy = {
  tables: [{
    baseToken: "bas_legacy",
    tableId: "tbl_legacy",
    name: "旧配置",
    mode: "manual",
    triggerField: "进度",
    triggerValue: "待剪辑",
    packageField: null,
    defaultPackageAlias: "Auto-cut-copyA",
  }],
  packages: { "Auto-cut-copyA": { projectId: "pkg", projectName: "包", workspacePath: "C:\\pkg", prompt: "固定" } },
};

test("keeps legacy routing until the workflow catalog has a Base", async () => {
  const store = { read: async () => ({ schemaVersion: 1, configVersion: 1, bases: [] }) };
  const runtime = createWorkflowRuntime({ config: legacy, store });
  assert.deepEqual((await runtime.getTables()).map((table) => table.tableId), ["tbl_legacy"]);
  assert.equal((await runtime.getConfig()).workflow, undefined);
});

test("treats an existing empty workflow catalog as authoritative and fails closed", async () => {
  const runtime = createWorkflowRuntime({
    config: legacy,
    store: {
      read: async () => ({ schemaVersion: 1, configVersion: 1, bases: [] }),
      hasPersistedConfig: async () => true,
    },
  });

  assert.deepEqual(await runtime.getTables(), []);
  assert.deepEqual((await runtime.getConfig()).workflow.bases, []);
});

test("uses the workflow catalog and active snapshots for runtime routing", async () => {
  const subject = {
    baseToken: "bas_live",
    tableId: "tbl_live",
    tableName: "新学科",
    lifecycle: "enabled",
    configVersion: 2,
    trigger: { fieldId: "fld", fieldName: "制作进度", startValue: "待制作", optionId: null },
    title: { fieldId: null, fieldName: null },
    execution: { mode: "automatic", concurrencyGroup: "g", maxConcurrent: 1, resourceGroups: [] },
    packageRoute: { routeMode: "fixed", packageAlias: "Auto-cut-copyA", subjectCodeFieldId: null, branchMap: null },
    upload: { enqueueMode: "manual", artifactSourceMode: "manual_select", artifactSourcePath: null, targetId: null, targetPath: null, uploadConcurrency: 1 },
  };
  const store = { read: async () => ({ schemaVersion: 1, configVersion: 2, bases: [{ baseToken: "bas_live", baseName: "Base", subjects: [subject] }] }) };
  const runtime = createWorkflowRuntime({ config: legacy, store });
  const config = await runtime.getConfig();
  assert.equal(config.workflow.bases[0].subjects[0].subjectKey, undefined);
  assert.deepEqual((await runtime.getTables()).map((table) => table.tableId), ["tbl_live"]);
  assert.equal((await runtime.getTables())[0].triggerValue, "待制作");
});

test("validates current Feishu metadata before persisting an enabled subject", async () => {
  const calls = [];
  const subject = {
    baseToken: "bas_live",
    baseName: "课程库",
    tableId: "tbl_live",
    tableName: "小学数学",
    trigger: { fieldId: "fld_status", fieldName: "制作进度", startValue: "待制作", optionId: "opt_ready" },
  };
  const store = {
    read: async () => ({ schemaVersion: 1, configVersion: 1, bases: [] }),
    syncSubject: async (value, options) => {
      calls.push(["persist", value, options]);
      return { ...value, lifecycle: options.lifecycle };
    },
  };
  const metadataReader = {
    validateSubject: async (value) => calls.push(["validate", value]),
  };
  const runtime = createWorkflowRuntime({ config: legacy, store, metadataReader });

  const result = await runtime.syncSubject(subject, { lifecycle: "enabled" });

  assert.equal(result.lifecycle, "enabled");
  assert.deepEqual(calls, [
    ["validate", subject],
    ["persist", subject, { lifecycle: "enabled" }],
  ]);
});

test("does not persist an enabled subject when live Feishu validation fails", async () => {
  const expected = Object.assign(new Error("safe failure"), { code: "INVALID_FIELD", status: 409 });
  let persisted = false;
  const runtime = createWorkflowRuntime({
    config: legacy,
    store: {
      read: async () => ({ schemaVersion: 1, configVersion: 1, bases: [] }),
      syncSubject: async () => {
        persisted = true;
        return {};
      },
    },
    metadataReader: { validateSubject: async () => { throw expected; } },
  });

  await assert.rejects(
    () => runtime.syncSubject({ baseToken: "bas_live", tableId: "tbl_live" }, { lifecycle: "enabled" }),
    (error) => error === expected,
  );
  assert.equal(persisted, false);
});

test("fails closed with a safe unavailable error when enabled validation has no Feishu client", async () => {
  let persisted = false;
  const runtime = createWorkflowRuntime({
    config: legacy,
    store: {
      read: async () => ({ schemaVersion: 1, configVersion: 1, bases: [] }),
      syncSubject: async () => {
        persisted = true;
        return {};
      },
    },
  });

  await assert.rejects(
    () => runtime.syncSubject({ baseToken: "bas_live", tableId: "tbl_live" }, { lifecycle: "enabled" }),
    (error) => error.code === "FEISHU_METADATA_UNAVAILABLE" && error.status === 503,
  );
  assert.equal(persisted, false);
});

test("does not require Feishu metadata to persist a disabled subject", async () => {
  const calls = [];
  const subject = { baseToken: "bas_live", tableId: "tbl_live" };
  const runtime = createWorkflowRuntime({
    config: legacy,
    store: {
      read: async () => ({ schemaVersion: 1, configVersion: 1, bases: [] }),
      syncSubject: async (value, options) => {
        calls.push([value, options]);
        return { ...value, lifecycle: options.lifecycle };
      },
    },
  });

  const result = await runtime.syncSubject(subject, { lifecycle: "disabled" });

  assert.equal(result.lifecycle, "disabled");
  assert.deepEqual(calls, [[subject, { lifecycle: "disabled" }]]);
});

test("runtime enable always validates live metadata and runtime disable remains metadata-independent", async () => {
  const calls = [];
  const subject = {
    subjectKey: "bas_live:tbl_live",
    baseToken: "bas_live",
    tableId: "tbl_live",
    baseName: "课程库",
    tableName: "数学",
    configVersion: 4,
  };
  const store = {
    read: async () => ({ schemaVersion: 1, configVersion: 4, bases: [{ baseToken: "bas_live", baseName: "课程库", subjects: [subject] }] }),
    enable: async (key, options) => { calls.push(["enable", key, options]); return { lifecycle: "enabled" }; },
    disable: async (key, options) => { calls.push(["disable", key, options]); return { lifecycle: "disabled" }; },
  };
  const metadataReader = { validateSubject: async (value) => calls.push(["validate", value]) };
  const runtime = createWorkflowRuntime({ config: legacy, store, metadataReader });

  await runtime.enable(subject.subjectKey);
  await runtime.disable(subject.subjectKey);

  assert.equal(calls[0][0], "validate");
  assert.equal(calls[1][0], "enable");
  assert.equal(calls[1][2].expectedVersion, subject.configVersion);
  assert.deepEqual(calls[2], ["disable", subject.subjectKey, {}]);
});

test("runtime does not expose an enable path that can bypass live metadata validation", async () => {
  let enabled = false;
  const runtime = createWorkflowRuntime({
    config: legacy,
    store: {
      read: async () => ({ schemaVersion: 1, configVersion: 1, bases: [] }),
      enable: async () => { enabled = true; },
    },
  });

  await assert.rejects(
    () => runtime.enable("bas_live:tbl_live"),
    (error) => error.code === "FEISHU_METADATA_UNAVAILABLE" && error.status === 503,
  );
  assert.equal(enabled, false);
});

test("keeps the workflow store API while decorating lifecycle synchronization", async () => {
  const configuration = { schemaVersion: 1, configVersion: 1, bases: [] };
  const store = {
    read: async () => configuration,
    exportShareable: async () => ({ portable: true }),
    importShareable: async (value) => ({ imported: value }),
    syncSubject: async (subject, options) => ({ ...subject, lifecycle: options.lifecycle }),
  };
  const runtime = createWorkflowRuntime({ config: legacy, store });

  assert.deepEqual(await runtime.exportShareable(), { portable: true });
  assert.deepEqual(await runtime.importShareable({ demo: true }), { imported: { demo: true } });
});
