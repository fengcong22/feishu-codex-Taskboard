import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import {
  WORKFLOW_SCHEMA_VERSION,
  subjectKey,
  validateWorkflowConfig,
} from "../src/workflow-config.mjs";
import { validateConfig as validateBridgeConfig } from "../src/config.mjs";
import { createWorkflowConfigStore } from "../src/workflow-config-store.mjs";

function validSubject(overrides = {}) {
  return {
    baseToken: "bas_demo_123",
    baseName: "课程库",
    tableId: "tbl_math_123",
    tableName: "数学",
    displayEnabled: true,
    lifecycle: "draft",
    trigger: {
      fieldId: "fld_progress",
      fieldName: "制作进度",
      startValue: "待制作",
      optionId: "opt_ready",
    },
    title: {
      fieldId: "fld_title",
      fieldName: "脚本名称",
    },
    execution: {
      mode: "manual",
      concurrencyGroup: "autocut-copy-a",
      maxConcurrent: 2,
      resourceGroups: ["剪映桌面"],
    },
    packageRoute: {
      routeMode: "fixed",
      packageAlias: "Auto-cut-copyA",
      subjectCodeFieldId: null,
      branchMap: null,
    },
    upload: {
      enqueueMode: "manual",
      artifactSourceMode: "manual_select",
      artifactSourcePath: "C:\\Users\\admin\\Desktop\\Auto-Cut-待上传",
      targetId: "nas-primary",
      targetPath: "\\\\nas\\剪映草稿\\数学",
      uploadConcurrency: 1,
    },
    ...overrides,
  };
}

function validConfig(overrides = {}) {
  return {
    schemaVersion: WORKFLOW_SCHEMA_VERSION,
    configVersion: 1,
    bases: [{
      baseToken: "bas_demo_123",
      baseName: "课程库",
      sourceUrlLabel: "https://example.test/base/bas_demo_123",
      metadataRefreshedAt: 1_700_000_000_000,
      subjects: [validSubject()],
    }],
    ...overrides,
  };
}

async function waitForFile(filename) {
  for (let attempt = 0; attempt < 250; attempt += 1) {
    try {
      await readFile(filename);
      return;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      await delay(20);
    }
  }
  throw new Error(`timed out waiting for ${filename}`);
}

function waitForExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    child.once("exit", resolve);
    child.once("error", reject);
  });
}

test("subjectKey uses base token and table id and keeps identities isolated", () => {
  assert.equal(subjectKey("bas_a", "tbl_x"), "bas_a:tbl_x");
  assert.notEqual(subjectKey("bas_a", "tbl_x"), subjectKey("bas_b", "tbl_x"));
  assert.throws(() => subjectKey("bas_a:bad", "tbl_x"), /baseToken/);
  assert.throws(() => subjectKey("bas_a", ""), /tableId/);
});

test("validateWorkflowConfig normalizes a custom start value and preserves field ids", () => {
  const normalized = validateWorkflowConfig(validConfig());
  assert.equal(normalized.schemaVersion, WORKFLOW_SCHEMA_VERSION);
  assert.equal(normalized.bases[0].subjects[0].subjectKey, "bas_demo_123:tbl_math_123");
  assert.equal(normalized.bases[0].subjects[0].trigger.startValue, "待制作");
  assert.equal(normalized.bases[0].subjects[0].trigger.fieldId, "fld_progress");
  assert.equal(normalized.bases[0].subjects[0].execution.maxConcurrent, 2);
});

test("preserves a synchronized course naming field descriptor", () => {
  const subject = validSubject({
    delivery: {
      version: 1,
      rootPath: null,
      courseNaming: { mode: "field", fieldId: "fld_title" },
      coursePathWriteback: { enabled: false, fieldId: null },
      writeback: {},
      finalDirectoryTrigger: { enabled: false, fieldId: null, optionId: null },
    },
    courseNamingField: {
      fieldId: "fld_title",
      fieldName: "脚本名称",
      type: 1,
      uiType: "Text",
    },
  });
  const normalized = validateWorkflowConfig(validConfig({
    bases: [{ ...validConfig().bases[0], subjects: [subject] }],
  }));

  assert.deepEqual(normalized.bases[0].subjects[0].courseNamingField, {
    fieldId: "fld_title",
    fieldName: "脚本名称",
    type: 1,
    uiType: "Text",
  });
});

test("package aliases may use controlled Chinese names but never paths or shell delimiters", () => {
  const input = validConfig();
  input.bases[0].subjects[0].packageRoute.packageAlias = "Auto-cut-小学语文";
  assert.equal(validateWorkflowConfig(input).bases[0].subjects[0].packageRoute.packageAlias, "Auto-cut-小学语文");
  input.bases[0].subjects[0].packageRoute.packageAlias = "C:\\unsafe";
  assert.throws(() => validateWorkflowConfig(input), /packageAlias/);
});

test("validateWorkflowConfig rejects duplicate identities and malformed active settings", () => {
  const duplicate = validConfig();
  duplicate.bases[0].subjects.push(validSubject({ tableName: "重复" }));
  assert.throws(() => validateWorkflowConfig(duplicate), /duplicate subjectKey/);

  const invalid = validConfig();
  invalid.bases[0].subjects[0].trigger.startValue = "";
  assert.throws(() => validateWorkflowConfig(invalid), /startValue/);

  const badConcurrency = validConfig();
  badConcurrency.bases[0].subjects[0].execution.maxConcurrent = 0;
  assert.throws(() => validateWorkflowConfig(badConcurrency), /maxConcurrent/);

  const badRoute = validConfig();
  badRoute.bases[0].subjects[0].packageRoute.packageAlias = "unknown alias";
  assert.throws(() => validateWorkflowConfig(badRoute), /packageAlias/);
});

test("Bridge config round-trip retains three staged audio sources without a schema upgrade", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "workflow-phased-audio-"));
  try {
    const stage = (optionId, value, audio) => ({
      enabled: true,
      trigger: {
        fieldId: "fld_progress",
        fieldName: "制作进度",
        optionId,
        value,
      },
      videoSource: { kind: "docx_section", anchorText: `${value}录屏` },
      reviewSource: { kind: "docx_section", anchorText: `${value}修改意见` },
      audio,
      artifactTargetPath: null,
      nameSuffix: `_${value}`,
    });
    const phasedSubject = validSubject({
      statusField: {
        fieldId: "fld_progress",
        fieldName: "制作进度",
        options: [
          { optionId: "opt_initial", value: "初稿" },
          { optionId: "opt_first_review", value: "初审修改" },
          { optionId: "opt_final_review", value: "终审修改" },
        ],
      },
      documentField: { fieldId: "fld_document", fieldName: "素材文档" },
      namingField: { fieldId: "fld_title", fieldName: "脚本名称" },
      stages: {
        initial: stage("opt_initial", "初稿", { mode: "video_original" }),
        first_review: stage("opt_first_review", "初审修改", {
          mode: "replace_original",
          source: { kind: "docx_section", anchorText: "二、PPT草稿+翻录" },
          durationToleranceSeconds: 1.5,
        }),
        final_review: stage("opt_final_review", "终审修改", {
          mode: "replace_original",
          source: { kind: "base_attachment", fieldId: "fld_audio" },
          durationToleranceSeconds: 3,
        }),
      },
    });
    const source = createWorkflowConfigStore({
      filename: path.join(directory, "source.json"),
      initial: validConfig({
        bases: [{
          ...validConfig().bases[0],
          subjects: [phasedSubject],
        }],
      }),
    });

    const shared = await source.exportShareable();
    const target = createWorkflowConfigStore({ filename: path.join(directory, "target.json") });
    const imported = await target.importShareable(shared);
    const roundTripped = imported.bases[0].subjects[0];
    const bridge = validateBridgeConfig({
      host: "127.0.0.1",
      port: 47824,
      taskboardUrl: "http://127.0.0.1:47823",
      stateFile: path.join(directory, "bridge-state.json"),
      tables: [JSON.parse(JSON.stringify(roundTripped))],
    });
    const bridgeSubject = bridge.tables[0];

    assert.equal(shared.schemaVersion, WORKFLOW_SCHEMA_VERSION);
    assert.equal(imported.schemaVersion, WORKFLOW_SCHEMA_VERSION);
    assert.deepEqual(Object.keys(roundTripped.stages), ["initial", "first_review", "final_review"]);
    assert.deepEqual(roundTripped.stages.initial.audio, { mode: "video_original" });
    assert.deepEqual(roundTripped.stages.first_review.audio, {
      mode: "replace_original",
      source: { kind: "docx_section", anchorText: "二、PPT草稿+翻录" },
      durationToleranceSeconds: 1.5,
    });
    assert.deepEqual(roundTripped.stages.final_review.audio, {
      mode: "replace_original",
      source: { kind: "base_attachment", fieldId: "fld_audio" },
      durationToleranceSeconds: 3,
    });
    assert.deepEqual(Object.keys(bridgeSubject.stages), ["initial", "first_review", "final_review"]);
    assert.equal(bridgeSubject.stages.first_review.audio.source.kind, "docx_section");
    assert.equal(bridgeSubject.stages.first_review.audio.source.anchorText, "二、PPT草稿+翻录");
    assert.equal(bridgeSubject.stages.final_review.audio.source.kind, "base_attachment");
    assert.equal(bridgeSubject.stages.final_review.audio.source.fieldId, "fld_audio");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("workflow sharing keeps delivery rules but removes the machine delivery root", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "workflow-delivery-share-"));
  try {
    const store = createWorkflowConfigStore({
      filename: path.join(directory, "workflow.json"),
      initial: validConfig({
        bases: [{
          ...validConfig().bases[0],
          subjects: [validSubject({
            upload: {
              ...validSubject().upload,
              enabled: true,
            },
            delivery: {
              version: 1,
              rootPath: "W:\\学科实拍素材临时传输\\【--剪映草稿--】",
              courseNaming: { mode: "field", fieldId: "fld_title" },
              coursePathWriteback: { enabled: true, fieldId: "fld_course_path" },
              writeback: {
                initial: {
                  onProcessing: [{ fieldId: "fld_progress", optionId: "opt_editing" }],
                  onUploaded: [{ fieldId: "fld_progress", optionId: "opt_finished" }],
                },
                first_review: { onProcessing: [], onUploaded: [] },
                final_review: { onProcessing: [], onUploaded: [] },
              },
              finalDirectoryTrigger: { enabled: false, fieldId: null, optionId: null },
            },
          })],
        }],
      }),
    });

    const local = (await store.read()).bases[0].subjects[0];
    assert.equal(local.delivery.rootPath, "W:\\学科实拍素材临时传输\\【--剪映草稿--】");
    assert.deepEqual(local.delivery.writeback.initial.onUploaded, [{ fieldId: "fld_progress", optionId: "opt_finished" }]);

    const shared = await store.exportShareable();
    const exported = shared.bases[0].subjects[0];
    assert.equal(exported.delivery.rootPath, null);
    assert.deepEqual(exported.delivery.courseNaming, { mode: "field", fieldId: "fld_title" });
    assert.deepEqual(exported.delivery.writeback.initial.onProcessing, [{ fieldId: "fld_progress", optionId: "opt_editing" }]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("workflow config store keeps drafts separate from active subjects and versions changes", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "workflow-config-"));
  const filename = path.join(directory, "workflow.json");
  let now = 1_700_000_000_000;
  const store = createWorkflowConfigStore({ filename, initial: validConfig(), now: () => now });

  assert.equal((await store.activeTables()).length, 0);

  await assert.rejects(
    () => store.saveDraft("bas_demo_123:tbl_math_123", { tableId: "tbl_other" }),
    /identity cannot be changed/,
  );
  const draft = await store.saveDraft("bas_demo_123:tbl_math_123", {
    displayEnabled: true,
    trigger: { startValue: "待剪辑" },
  });
  assert.equal(draft.lifecycle, "draft");
  assert.equal(draft.configVersion, 2);
  assert.equal((await store.activeTables()).length, 0);

  now += 100;
  const enabled = await store.enable("bas_demo_123:tbl_math_123");
  assert.equal(enabled.lifecycle, "enabled");
  assert.equal(enabled.configVersion, 3);
  assert.equal((await store.activeTables())[0].trigger.startValue, "待剪辑");

  now += 100;
  const disabled = await store.disable("bas_demo_123:tbl_math_123");
  assert.equal(disabled.lifecycle, "disabled");
  assert.equal(disabled.configVersion, 4);
  assert.equal((await store.activeTables()).length, 0);

  const persisted = JSON.parse(await readFile(filename, "utf8"));
  assert.equal(persisted.bases[0].subjects[0].configVersion, 4);
  assert.equal((await stat(filename)).isFile(), true);
});

test("preserves the previous config when the history sidecar cannot be committed", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "workflow-config-sidecar-failure-"));
  const filename = path.join(directory, "workflow.json");
  const store = createWorkflowConfigStore({ filename, initial: validConfig() });
  await store.saveDraft("bas_demo_123:tbl_math_123", { displayEnabled: false });
  const before = await readFile(filename, "utf8");
  await mkdir(`${filename}.versions.json`);

  await assert.rejects(
    () => store.enable("bas_demo_123:tbl_math_123"),
    (error) => error?.code === "STATE_LOCK_TARGET_UNSUPPORTED",
  );

  assert.equal(await readFile(filename, "utf8"), before);
  const persisted = JSON.parse(before);
  assert.equal(persisted.bases[0].subjects[0].lifecycle, "draft");
  assert.equal(persisted.bases[0].subjects[0].configVersion, 2);
});

test("recovers the previous config and history pair after interruption between writes", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "workflow-config-interrupted-pair-"));
  const filename = path.join(directory, "workflow.json");
  const marker = path.join(directory, "history-write-entered");
  const store = createWorkflowConfigStore({ filename, initial: validConfig() });
  await store.saveDraft("bas_demo_123:tbl_math_123", { displayEnabled: false });
  const before = await readFile(filename, "utf8");
  const moduleUrl = new URL("../src/workflow-config-store.mjs", import.meta.url).href;
  const source = `
    import { writeFile } from "node:fs/promises";
    import { createWorkflowConfigStore } from ${JSON.stringify(moduleUrl)};
    const store = createWorkflowConfigStore({ filename: process.argv[1] });
    store.history.syncSubject = async () => {
      await writeFile(process.argv[2], "entered");
      await new Promise(() => setInterval(() => {}, 1000));
    };
    await store.enable("bas_demo_123:tbl_math_123");
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", source, filename, marker], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await waitForExit(child).catch(() => {});
    await rm(directory, { recursive: true, force: true });
  });

  await waitForFile(marker);
  assert.equal(JSON.parse(await readFile(filename, "utf8")).bases[0].subjects[0].lifecycle, "enabled");
  child.kill();
  await waitForExit(child);

  const recovered = createWorkflowConfigStore({ filename });
  const current = await recovered.read();
  assert.equal(current.bases[0].subjects[0].lifecycle, "draft");
  assert.equal(current.bases[0].subjects[0].configVersion, 2);
  assert.equal(await readFile(filename, "utf8"), before);
  await assert.rejects(
    () => readFile(`${filename}.versions.json`, "utf8"),
    (error) => error?.code === "ENOENT",
  );
});

test("share export removes local paths and import creates drafts without enabling", async () => {
  const sourceDirectory = await mkdtemp(path.join(os.tmpdir(), "workflow-export-"));
  const source = createWorkflowConfigStore({
    filename: path.join(sourceDirectory, "source.json"),
    initial: validConfig(),
  });
  await source.enable("bas_demo_123:tbl_math_123");
  const exported = await source.exportShareable();
  const serialized = JSON.stringify(exported);
  assert.equal(exported.schemaVersion, WORKFLOW_SCHEMA_VERSION);
  assert.match(serialized, /待制作/);
  assert.doesNotMatch(serialized, /Users\\admin/);
  assert.doesNotMatch(serialized, /nas\\剪映草稿/);
  assert.equal(exported.bases[0].subjects[0].lifecycle, "enabled");

  const targetDirectory = await mkdtemp(path.join(os.tmpdir(), "workflow-import-"));
  const target = createWorkflowConfigStore({ filename: path.join(targetDirectory, "target.json") });
  const imported = await target.importShareable(exported);
  assert.equal(imported.bases[0].subjects[0].lifecycle, "draft");
  assert.equal((await target.activeTables()).length, 0);
  assert.equal(imported.bases[0].subjects[0].upload.artifactSourcePath, null);
  assert.equal(imported.bases[0].subjects[0].upload.targetPath, null);
});

test("committed share import does not persist a pasted source URL containing credentials", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "workflow-import-source-url-"));
  const filename = path.join(directory, "workflow.json");
  const store = createWorkflowConfigStore({ filename });
  const shared = validConfig();
  shared.bases[0].sourceUrlLabel = "https://user:shared-secret@example.test/base/bas_demo_123?token=shared-secret";

  await store.importShareable(shared, { dryRun: false });

  const persisted = JSON.parse(await readFile(filename, "utf8"));
  assert.equal(persisted.bases[0].sourceUrlLabel, null);
  assert.doesNotMatch(JSON.stringify(persisted), /shared-secret/u);
});

test("importing a share over an enabled subject leaves the previous live snapshot active", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "workflow-import-active-"));
  const store = createWorkflowConfigStore({ filename: path.join(directory, "workflow.json"), initial: validConfig() });
  const enabled = await store.enable("bas_demo_123:tbl_math_123");
  const shared = await store.exportShareable();
  shared.bases[0].subjects[0].trigger.startValue = "待剪辑";
  const imported = await store.importShareable(shared);
  assert.equal(imported.bases[0].subjects[0].lifecycle, "draft");
  assert.equal((await store.activeTables())[0].trigger.startValue, "待制作");
  assert.equal((await store.activeTables())[0].configVersion, enabled.configVersion);
});

test("syncSubject persists enabled and disabled lifecycle through the real store", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "workflow-sync-real-"));
  const filename = path.join(directory, "workflow.json");
  let now = 1_700_000_000_000;
  const store = createWorkflowConfigStore({
    filename,
    initial: { schemaVersion: WORKFLOW_SCHEMA_VERSION, configVersion: 1, bases: [] },
    now: () => now,
    packageAliases: ["Auto-cut-copyA"],
  });
  const input = validSubject({ configVersion: 2 });

  const enabled = await store.syncSubject(input, { lifecycle: "enabled", expectedVersion: 1 });
  assert.equal(enabled.lifecycle, "enabled");
  assert.equal((await store.activeTables()).length, 1);
  assert.equal((await store.activeTables())[0].subjectKey, "bas_demo_123:tbl_math_123");

  const persistedEnabled = JSON.parse(await readFile(filename, "utf8"));
  assert.equal(persistedEnabled.bases[0].subjects[0].lifecycle, "enabled");
  assert.equal(persistedEnabled.bases[0].subjects[0].subjectKey, "bas_demo_123:tbl_math_123");
  assert.equal(persistedEnabled.configVersion, 2);

  now += 100;
  const disabledInput = structuredClone(input);
  disabledInput.configVersion = 3;
  const disabled = await store.syncSubject(disabledInput, { lifecycle: "disabled", expectedVersion: 2 });
  assert.equal(disabled.lifecycle, "disabled");
  assert.equal((await store.activeTables()).length, 0);
  const persistedDisabled = JSON.parse(await readFile(filename, "utf8"));
  assert.equal(persistedDisabled.bases[0].subjects[0].lifecycle, "disabled");
  assert.equal(persistedDisabled.configVersion, 3);

  const temporaryFiles = (await readdir(directory)).filter((name) => name.endsWith(".tmp"));
  assert.deepEqual(temporaryFiles, []);
});

test("refreshes dynamic package aliases before each lifecycle sync", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "workflow-sync-dynamic-packages-"));
  let aliases = ["Auto-cut-copyA"];
  const store = createWorkflowConfigStore({
    filename: path.join(directory, "workflow.json"),
    initial: { schemaVersion: WORKFLOW_SCHEMA_VERSION, configVersion: 1, bases: [] },
    packageAliases: async () => aliases,
  });
  try {
    await store.syncSubject(validSubject({ configVersion: 2 }), {
      lifecycle: "enabled",
      expectedVersion: 1,
    });
    aliases = ["Auto-cut-小学语文"];
    const next = validSubject({
      configVersion: 3,
      packageRoute: {
        routeMode: "fixed",
        packageAlias: "Auto-cut-小学语文",
        subjectCodeFieldId: null,
        branchMap: null,
      },
    });
    const synced = await store.syncSubject(next, {
      lifecycle: "enabled",
      expectedVersion: 2,
    });
    assert.equal(synced.packageRoute.packageAlias, "Auto-cut-小学语文");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("syncSubject accepts an exact same-version replay without rewriting the persisted document", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "workflow-sync-replay-"));
  const filename = path.join(directory, "workflow.json");
  let now = 1_700_000_000_000;
  const store = createWorkflowConfigStore({
    filename,
    initial: { schemaVersion: WORKFLOW_SCHEMA_VERSION, configVersion: 1, bases: [] },
    now: () => now,
    packageAliases: ["Auto-cut-copyA"],
  });
  const input = validSubject({ configVersion: 2 });
  const enabled = await store.syncSubject(input, { lifecycle: "enabled", expectedVersion: 1 });
  const persistedBeforeReplay = await readFile(filename, "utf8");

  now += 100;
  const replayed = await store.syncSubject(structuredClone(input), {
    lifecycle: "enabled",
    expectedVersion: 1,
  });

  assert.deepEqual(replayed, enabled);
  assert.equal(await readFile(filename, "utf8"), persistedBeforeReplay);
});

test("syncSubject rejects a same-version replay whose normalized snapshot differs", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "workflow-sync-replay-conflict-"));
  const store = createWorkflowConfigStore({
    filename: path.join(directory, "workflow.json"),
    initial: { schemaVersion: WORKFLOW_SCHEMA_VERSION, configVersion: 1, bases: [] },
    packageAliases: ["Auto-cut-copyA"],
  });
  const input = validSubject({ configVersion: 2 });
  await store.syncSubject(input, { lifecycle: "enabled", expectedVersion: 1 });

  const changed = structuredClone(input);
  changed.trigger.startValue = "旧快照";
  await assert.rejects(
    () => store.syncSubject(changed, { lifecycle: "enabled", expectedVersion: 1 }),
    (error) => error.code === "WORKFLOW_CONFIG_VERSION_MISMATCH" && error.status === 409,
  );
});

test("syncSubject uses an atomic expected-version compare-and-swap and rejects stale or downgraded snapshots", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "workflow-sync-cas-"));
  const filename = path.join(directory, "workflow.json");
  const store = createWorkflowConfigStore({
    filename,
    initial: { schemaVersion: WORKFLOW_SCHEMA_VERSION, configVersion: 1, bases: [] },
    packageAliases: ["Auto-cut-copyA"],
  });
  const first = validSubject({ configVersion: 2 });

  await assert.rejects(
    () => store.syncSubject(first, { lifecycle: "enabled" }),
    (error) => error.code === "WORKFLOW_CONFIG_VERSION_MISMATCH" && error.status === 409,
  );
  const enabled = await store.syncSubject(first, { lifecycle: "enabled", expectedVersion: 1 });
  assert.equal(enabled.configVersion, 2);

  await assert.rejects(
    () => store.syncSubject({ ...structuredClone(first), configVersion: 2, trigger: { ...first.trigger, startValue: "旧快照" } }, {
      lifecycle: "enabled",
      expectedVersion: 1,
    }),
    (error) => error.code === "WORKFLOW_CONFIG_VERSION_MISMATCH",
  );
  await assert.rejects(
    () => store.syncSubject({ ...structuredClone(first), configVersion: 2 }, {
      lifecycle: "disabled",
      expectedVersion: 2,
    }),
    (error) => error.code === "WORKFLOW_CONFIG_VERSION_MISMATCH",
  );
  assert.equal((await store.read()).bases[0].subjects[0].configVersion, 2);
});

test("syncSubject accepts a newer enable snapshot after Taskboard-only draft edits", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "workflow-sync-draft-gap-"));
  const store = createWorkflowConfigStore({
    filename: path.join(directory, "workflow.json"),
    initial: { schemaVersion: WORKFLOW_SCHEMA_VERSION, configVersion: 1, bases: [] },
    packageAliases: ["Auto-cut-copyA"],
  });
  const initiallyEnabled = validSubject({ configVersion: 3 });
  await store.syncSubject(initiallyEnabled, { lifecycle: "enabled", expectedVersion: 2 });

  // Taskboard keeps these two draft revisions local while Bridge continues
  // serving the last enabled v3 snapshot.  Its next lifecycle sync is v6.
  const reenabled = structuredClone(initiallyEnabled);
  reenabled.configVersion = 6;
  reenabled.trigger.startValue = "待剪辑";
  const result = await store.syncSubject(reenabled, { lifecycle: "enabled", expectedVersion: 5 });

  assert.equal(result.configVersion, 6);
  assert.equal(result.trigger.startValue, "待剪辑");
  assert.equal((await store.activeTables())[0].configVersion, 6);
});

test("syncSubject can disable even when the incoming package alias is no longer installed", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "workflow-sync-disable-alias-"));
  const filename = path.join(directory, "workflow.json");
  const store = createWorkflowConfigStore({
    filename,
    initial: { schemaVersion: WORKFLOW_SCHEMA_VERSION, configVersion: 1, bases: [] },
    packageAliases: ["Auto-cut-copyA"],
  });
  const enabled = await store.syncSubject(validSubject({ configVersion: 2 }), {
    lifecycle: "enabled",
    expectedVersion: 1,
  });
  const disabledInput = structuredClone(enabled);
  disabledInput.configVersion = 3;
  disabledInput.packageRoute.packageAlias = "Auto-cut-removed";

  const disabled = await store.syncSubject(disabledInput, {
    lifecycle: "disabled",
    expectedVersion: 2,
  });
  assert.equal(disabled.lifecycle, "disabled");
  assert.equal(disabled.configVersion, 3);
});

test("syncSubject always clears machine-local upload paths before persisting", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "workflow-sync-paths-"));
  const filename = path.join(directory, "workflow.json");
  const store = createWorkflowConfigStore({
    filename,
    initial: { schemaVersion: WORKFLOW_SCHEMA_VERSION, configVersion: 1, bases: [] },
    packageAliases: ["Auto-cut-copyA"],
  });
  const synced = await store.syncSubject(validSubject({ configVersion: 2 }), { lifecycle: "enabled", expectedVersion: 1 });

  assert.equal(synced.upload.artifactSourcePath, null);
  assert.equal(synced.upload.targetPath, null);
  const persisted = JSON.parse(await readFile(filename, "utf8"));
  assert.equal(persisted.bases[0].subjects[0].upload.artifactSourcePath, null);
  assert.equal(persisted.bases[0].subjects[0].upload.targetPath, null);
});

test("syncSubject rejects an unknown Auto-Cut alias without changing the persisted document", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "workflow-sync-alias-"));
  const filename = path.join(directory, "workflow.json");
  const store = createWorkflowConfigStore({
    filename,
    initial: { schemaVersion: WORKFLOW_SCHEMA_VERSION, configVersion: 1, bases: [] },
    packageAliases: ["Auto-cut-copyA"],
  });
  await store.syncSubject(validSubject({ configVersion: 2 }), { lifecycle: "enabled", expectedVersion: 1 });
  const before = await readFile(filename, "utf8");
  const unknown = structuredClone(validSubject());
  unknown.packageRoute.packageAlias = "Auto-cut-小学语文";

  await assert.rejects(
    () => store.syncSubject({ ...unknown, configVersion: 3 }, { lifecycle: "enabled", expectedVersion: 2 }),
    (error) => error?.code === "WORKFLOW_PACKAGE_ALIAS_UNBOUND",
  );
  assert.equal(await readFile(filename, "utf8"), before);
  assert.equal((await store.activeTables())[0].packageRoute.packageAlias, "Auto-cut-copyA");
  assert.deepEqual(
    (await readdir(directory)).filter((name) => name.endsWith(".tmp")),
    [],
  );
});

test("concurrent real stores preserve both syncSubject writes in one atomically replaced document", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "workflow-sync-concurrent-"));
  const filename = path.join(directory, "workflow.json");
  const initial = { schemaVersion: WORKFLOW_SCHEMA_VERSION, configVersion: 1, bases: [] };
  const storeA = createWorkflowConfigStore({ filename, initial, packageAliases: ["Auto-cut-copyA"] });
  const storeB = createWorkflowConfigStore({ filename, initial, packageAliases: ["Auto-cut-copyA"] });
  const subjectB = validSubject({
    baseToken: "bas_demo_456",
    baseName: "课程库二",
    tableId: "tbl_chinese_456",
    tableName: "语文",
  });

  await Promise.all([
    storeA.syncSubject(validSubject({ configVersion: 2 }), { lifecycle: "enabled", expectedVersion: 1 }),
    storeB.syncSubject({ ...subjectB, configVersion: 2 }, { lifecycle: "enabled", expectedVersion: 1 }),
  ]);

  const persisted = JSON.parse(await readFile(filename, "utf8"));
  const subjects = persisted.bases.flatMap((base) => base.subjects);
  assert.equal(subjects.length, 2);
  assert.deepEqual(
    new Set(subjects.map((subject) => subject.subjectKey)),
    new Set(["bas_demo_123:tbl_math_123", "bas_demo_456:tbl_chinese_456"]),
  );
  assert.equal((await storeA.activeTables()).length, 2);
  assert.deepEqual(
    (await readdir(directory)).filter((name) => name.endsWith(".tmp")),
    [],
  );
});

test("syncSubject persists enabled and disabled lifecycle without importing machine paths", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "workflow-sync-real-"));
  const filename = path.join(directory, "workflow.json");
  const store = createWorkflowConfigStore({
    filename,
    initial: { schemaVersion: WORKFLOW_SCHEMA_VERSION, configVersion: 1, bases: [] },
    packageAliases: ["Auto-cut-copyA"],
  });

  const subjectInput = validSubject({
    subjectKey: undefined,
    lifecycle: undefined,
    upload: {
      enqueueMode: "automatic",
      artifactSourceMode: "watch_directory",
      artifactSourcePath: "C:\\Users\\admin\\Desktop\\Auto-Cut-待上传",
      targetId: "nas-primary",
      targetPath: "\\\\nas\\剪映草稿\\数学",
      uploadConcurrency: 2,
    },
  });
  subjectInput.configVersion = 2;
  const enabled = await store.syncSubject(subjectInput, { lifecycle: "enabled", expectedVersion: 1 });
  assert.equal(enabled.lifecycle, "enabled");
  assert.equal((await store.activeTables()).length, 1);
  assert.equal((await store.activeTables())[0].subjectKey, "bas_demo_123:tbl_math_123");
  assert.equal(enabled.upload.artifactSourcePath, null);
  assert.equal(enabled.upload.targetPath, null);

  const persisted = JSON.parse(await readFile(filename, "utf8"));
  assert.equal(persisted.configVersion, 2);
  assert.equal(persisted.bases[0].subjects[0].lifecycle, "enabled");
  assert.equal(persisted.bases[0].subjects[0].upload.artifactSourcePath, null);
  assert.equal(persisted.bases[0].subjects[0].upload.targetPath, null);

  const disabled = await store.syncSubject({
    baseToken: "bas_demo_123",
    tableId: "tbl_math_123",
    configVersion: 3,
  }, { lifecycle: "disabled", expectedVersion: 2 });
  assert.equal(disabled.lifecycle, "disabled");
  assert.equal((await store.activeTables()).length, 0);
  assert.equal((await store.read()).bases[0].subjects[0].upload.targetPath, null);
});

test("syncSubject rejects an Auto-Cut alias that is not locally configured", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "workflow-sync-alias-"));
  const filename = path.join(directory, "workflow.json");
  const store = createWorkflowConfigStore({
    filename,
    initial: { schemaVersion: WORKFLOW_SCHEMA_VERSION, configVersion: 1, bases: [] },
    packageAliases: ["Auto-cut-copyA"],
  });
  const input = validSubject({
    packageRoute: {
      routeMode: "fixed",
      packageAlias: "Auto-cut-not-installed",
      subjectCodeFieldId: null,
      branchMap: null,
    },
  });

  await assert.rejects(
    () => store.syncSubject({ ...input, configVersion: 2 }, { lifecycle: "enabled", expectedVersion: 1 }),
    (error) => error?.code === "WORKFLOW_PACKAGE_ALIAS_UNBOUND",
  );
  assert.equal((await store.read()).bases.length, 0);
});

test("share import dry-run reports missing live Base, table, and fields without persisting or leaking errors", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "workflow-import-metadata-"));
  const filename = path.join(directory, "workflow.json");
  const imported = validConfig({
    bases: [
      {
        baseToken: "bas_missing",
        baseName: "已删除课程库",
        sourceUrlLabel: "https://user:shared-secret@example.test/base/bas_missing",
        metadataRefreshedAt: null,
        subjects: [validSubject({
          baseToken: "bas_missing",
          baseName: "已删除课程库",
          tableId: "tbl_missing_base",
          upload: {
            enqueueMode: "manual",
            artifactSourceMode: "manual_select",
            artifactSourcePath: "C:\\shared-secret\\source",
            targetId: null,
            targetPath: null,
            uploadConcurrency: 1,
          },
        })],
      },
      {
        baseToken: "bas_table",
        baseName: "课程库二",
        sourceUrlLabel: null,
        metadataRefreshedAt: null,
        subjects: [validSubject({
          baseToken: "bas_table",
          baseName: "课程库二",
          tableId: "tbl_missing",
          tableName: "已删除学科",
          upload: {
            enqueueMode: "manual",
            artifactSourceMode: "manual_select",
            artifactSourcePath: null,
            targetId: null,
            targetPath: null,
            uploadConcurrency: 1,
          },
        })],
      },
      {
        baseToken: "bas_fields",
        baseName: "课程库三",
        sourceUrlLabel: null,
        metadataRefreshedAt: null,
        subjects: [validSubject({
          baseToken: "bas_fields",
          baseName: "课程库三",
          tableId: "tbl_fields",
          tableName: "语文",
          upload: {
            enqueueMode: "manual",
            artifactSourceMode: "manual_select",
            artifactSourcePath: null,
            targetId: null,
            targetPath: null,
            uploadConcurrency: 1,
          },
        })],
      },
    ],
  });
  const metadataRequests = [];
  const metadataReader = {
    async preview({ baseToken }) {
      metadataRequests.push(baseToken);
      if (baseToken === "bas_missing") {
        const error = new Error("SDK response contained shared-secret");
        error.code = "FEISHU_BASE_NOT_FOUND";
        throw error;
      }
      if (baseToken === "bas_table") {
        return { baseToken, baseName: "课程库二", tables: [] };
      }
      return {
        baseToken,
        baseName: "课程库三",
        tables: [{
          tableId: "tbl_fields",
          tableName: "语文",
          fields: [{ fieldId: "fld_other", fieldName: "其他", options: [] }],
        }],
      };
    },
  };
  const store = createWorkflowConfigStore({
    filename,
    metadataReader,
    packageAliases: {
      "Auto-cut-copyA": { workspacePath: "D:\\Auto-Cut\\copyA" },
    },
  });

  const result = await store.importShareable(imported, { dryRun: true });

  assert.deepEqual(metadataRequests, ["bas_missing", "bas_table", "bas_fields"]);
  assert.equal(result.diagnosticsOk, false);
  assert.deepEqual(
    result.diagnostics.filter((entry) => ["BASE_NOT_FOUND", "TABLE_NOT_FOUND", "FIELD_NOT_FOUND"].includes(entry.code))
      .map((entry) => entry.code),
    ["BASE_NOT_FOUND", "TABLE_NOT_FOUND", "FIELD_NOT_FOUND", "FIELD_NOT_FOUND"],
  );
  assert.ok(result.configuration.bases.every((base) => base.subjects.every((subject) => subject.lifecycle === "draft")));
  assert.equal(result.configuration.bases[0].sourceUrlLabel, null);
  assert.doesNotMatch(JSON.stringify(result), /shared-secret|Auto-Cut\\\\copyA/u);
  await assert.rejects(() => readFile(filename, "utf8"), (error) => error?.code === "ENOENT");
  assert.equal((await store.activeTables()).length, 0);
});

test("share import dry-run reports package workspace and machine-local upload bindings", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "workflow-import-bindings-"));
  const filename = path.join(directory, "workflow.json");
  const current = validConfig();
  const imported = validConfig();
  imported.bases[0].subjects.push(
    validSubject({
      tableId: "tbl_unknown_package",
      tableName: "英语",
      packageRoute: {
        routeMode: "fixed",
        packageAlias: "Auto-cut-英语",
        subjectCodeFieldId: null,
        branchMap: null,
      },
      upload: {
        enqueueMode: "manual",
        artifactSourceMode: "manual_select",
        artifactSourcePath: null,
        targetId: null,
        targetPath: null,
        uploadConcurrency: 1,
      },
    }),
    validSubject({
      tableId: "tbl_workspace",
      tableName: "物理",
      packageRoute: {
        routeMode: "fixed",
        packageAlias: "Auto-cut-unbound",
        subjectCodeFieldId: null,
        branchMap: null,
      },
      upload: {
        enqueueMode: "manual",
        artifactSourceMode: "manual_select",
        artifactSourcePath: null,
        targetId: null,
        targetPath: null,
        uploadConcurrency: 1,
      },
    }),
    validSubject({
      tableId: "tbl_paths",
      tableName: "化学",
      upload: {
        enqueueMode: "automatic",
        artifactSourceMode: "watch_directory",
        artifactSourcePath: "C:\\foreign-machine\\zip",
        targetId: "nas-primary",
        targetPath: "\\\\foreign-nas\\drafts",
        uploadConcurrency: 1,
      },
    }),
  );
  const fields = [
    { fieldId: "fld_progress", fieldName: "制作进度", options: [{ id: "opt_ready", name: "待制作" }] },
    { fieldId: "fld_title", fieldName: "脚本名称", options: [] },
  ];
  const metadataReader = {
    async preview({ baseToken }) {
      return {
        baseToken,
        baseName: "课程库",
        tables: imported.bases[0].subjects.map((subject) => ({
          tableId: subject.tableId,
          tableName: subject.tableName,
          fields,
        })),
      };
    },
  };
  const store = createWorkflowConfigStore({
    filename,
    initial: current,
    metadataReader,
    packageAliases: {
      "Auto-cut-copyA": { workspacePath: "D:\\Auto-Cut\\copyA" },
      "Auto-cut-unbound": { workspacePath: null },
    },
  });

  const before = JSON.stringify(await store.read());
  const result = await store.importShareable(imported, { dryRun: true });

  assert.deepEqual(
    result.diagnostics.filter((entry) => entry.severity !== "info").map((entry) => entry.code),
    [
      "PACKAGE_ALIAS_UNAVAILABLE",
      "PACKAGE_WORKSPACE_PATH_UNBOUND",
      "ARTIFACT_SOURCE_PATH_UNBOUND",
      "UPLOAD_TARGET_PATH_UNBOUND",
    ],
  );
  assert.equal(result.diagnostics.some((entry) => entry.path.endsWith("tbl_math_123.upload.artifactSourcePath")), false);
  assert.equal(result.diagnostics.some((entry) => entry.path.endsWith("tbl_math_123.upload.targetPath")), false);
  assert.doesNotMatch(JSON.stringify(result), /foreign-machine|foreign-nas|Auto-Cut\\\\copyA/u);
  assert.equal(JSON.stringify(await store.read()), before);
  assert.equal((await store.activeTables()).length, 0);
});

test("share import dry-run reuses enable metadata comparisons for saved names and trigger options", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "workflow-import-live-comparison-"));
  const filename = path.join(directory, "workflow.json");
  const imported = validConfig();
  const metadataReader = {
    async preview({ baseToken }) {
      return {
        baseToken,
        baseName: "重命名后的课程库",
        tables: [{
          tableId: "tbl_math_123",
          tableName: "重命名后的数学",
          fields: [
            {
              fieldId: "fld_progress",
              fieldName: "重命名后的进度",
              type: 3,
              options: [{ id: "opt_ready", name: "待剪辑" }],
            },
            { fieldId: "fld_title", fieldName: "重命名后的脚本", type: 1, options: [] },
          ],
        }],
      };
    },
  };
  const store = createWorkflowConfigStore({ filename, metadataReader });

  const result = await store.importShareable(imported, { dryRun: true });

  assert.equal(result.diagnosticsOk, false);
  assert.deepEqual(
    new Set(result.diagnostics.filter((entry) => entry.severity === "error").map((entry) => entry.code)),
    new Set(["BASE_NAME_MISMATCH", "TABLE_NAME_MISMATCH", "FIELD_NAME_MISMATCH", "OPTION_NOT_FOUND"]),
  );
  assert.equal((await store.activeTables()).length, 0);
});

test("share import dry-run reports every phased attachment mismatch from live metadata", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "workflow-import-phased-attachments-"));
  const filename = path.join(directory, "workflow.json");
  const stage = (optionId, value) => ({
    enabled: true,
    trigger: { fieldId: "fld_progress", fieldName: "制作进度", optionId, value },
    videoSource: { kind: "docx_section", anchorText: `${value}录屏` },
    reviewSource: { kind: "docx_section", anchorText: `${value}修改意见` },
    audio: { mode: "video_original" },
    artifactTargetPath: null,
    nameSuffix: `_${value}`,
  });
  const imported = validConfig();
  Object.assign(imported.bases[0].subjects[0], {
    statusField: { fieldId: "fld_progress", fieldName: "制作进度" },
    documentField: { fieldId: "fld_document", fieldName: "素材文档" },
    namingField: { fieldId: "fld_title", fieldName: "脚本名称" },
    stages: {
      initial: {
        ...stage("opt_initial", "初稿"),
        videoSource: { kind: "base_attachment", fieldId: "fld_missing_video" },
      },
      first_review: {
        ...stage("opt_first_review", "初审修改"),
        audio: {
          mode: "replace_original",
          source: { kind: "base_attachment", fieldId: "fld_text_audio" },
          durationToleranceSeconds: 3,
        },
      },
      final_review: stage("opt_final_review", "终审修改"),
    },
  });
  const metadataReader = {
    async preview({ baseToken }) {
      return {
        baseToken,
        baseName: "课程库",
        tables: [{
          tableId: "tbl_math_123",
          tableName: "数学",
          fields: [
            {
              fieldId: "fld_progress",
              fieldName: "制作进度",
              type: 3,
              options: [
                { id: "opt_initial", name: "初稿" },
                { id: "opt_first_review", name: "初审修改" },
                { id: "opt_final_review", name: "终审修改" },
              ],
            },
            { fieldId: "fld_document", fieldName: "素材文档", type: 1, options: [] },
            { fieldId: "fld_title", fieldName: "脚本名称", type: 1, options: [] },
            { fieldId: "fld_text_audio", fieldName: "音频文本", type: 1, options: [] },
          ],
        }],
      };
    },
  };
  const store = createWorkflowConfigStore({
    filename,
    metadataReader,
    packageAliases: { "Auto-cut-copyA": { workspacePath: "D:\\Auto-Cut\\copyA" } },
  });

  const result = await store.importShareable(imported, { dryRun: true });

  assert.deepEqual(
    result.diagnostics
      .filter((entry) => entry.path.includes(".stages."))
      .map((entry) => [entry.code, entry.path]),
    [
      ["FIELD_NOT_FOUND", "bases.bas_demo_123.subjects.tbl_math_123.stages.initial.videoSource.fieldId"],
      ["FIELD_TYPE_INVALID", "bases.bas_demo_123.subjects.tbl_math_123.stages.first_review.audio.source.fieldId"],
    ],
  );
  assert.equal(result.diagnosticsOk, false);
  await assert.rejects(() => readFile(filename, "utf8"), (error) => error?.code === "ENOENT");
});
