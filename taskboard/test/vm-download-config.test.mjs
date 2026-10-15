import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { resolveVmDownloadConfig } from "../server/vm-download-config.mjs";

test("VM config reads only intended settings without mutating process environment or exposing raw errors", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vm-config-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const envFile = path.join(root, ".env.local");
  await writeFile(envFile, 'FEISHU_APP_ID=fixture-id\nFEISHU_APP_SECRET=fixture-secret\nSHADOW_TOKEN=must-ignore\nCODEX_TASKBOARD_HOST=evil\n');
  const environment = { FEISHU_APP_ID: "override-id" };
  const config = resolveVmDownloadConfig({ dataDirectory: root, environment, envFile });
  assert.equal(config.appId, "override-id"); assert.equal(config.appSecret, "fixture-secret");
  assert.equal(config.statePath, path.join(root, "vm-approval.sqlite"));
  assert.deepEqual(environment, { FEISHU_APP_ID: "override-id" });
  assert.doesNotMatch(JSON.stringify(config), /must-ignore|evil/);
  await assert.rejects(async () => resolveVmDownloadConfig({ dataDirectory: root, environment: { CODEX_VM_DOWNLOAD_PRIVATE_ENDPOINTS_JSON: "secret broken input" } }), error => error.code === "VM_DOWNLOAD_CONFIG_INVALID" && !error.message.includes("secret"));
});
test("default service adopts existing CLI queue and refuses ambiguous two-queue history", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vm-config-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataDirectory = path.join(root, "taskboard");
  const legacy = path.join(root, "vm-download-check", "approval-workflow.sqlite");
  await mkdir(path.dirname(legacy), { recursive: true }); await writeFile(legacy, "fixture path only");
  assert.equal(resolveVmDownloadConfig({ dataDirectory, environment: {} }).statePath, legacy);
  await mkdir(dataDirectory); await writeFile(path.join(dataDirectory, "vm-approval.sqlite"), "another fixture");
  assert.throws(() => resolveVmDownloadConfig({ dataDirectory, environment: {} }), { code: "VM_DOWNLOAD_STATE_AMBIGUOUS" });
  assert.equal(resolveVmDownloadConfig({ dataDirectory, environment: { CODEX_VM_APPROVAL_STATE: legacy } }).statePath, legacy);
});

test("VM runner configuration reads local fixed paths and respects environment overrides", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vm-config-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const envFile = path.join(root, ".env.local");
  const localPython = path.join(root, "local-python.exe");
  const overridePython = path.join(root, "override-python.exe");
  const runRoot = path.join(root, "runs");
  await writeFile(envFile, `CODEX_VM_PMO_PYTHON_PATH="${localPython.replaceAll("\\", "/")}"\nCODEX_VM_PMO_RUN_ROOT="${runRoot.replaceAll("\\", "/")}"\n`);
  const config = resolveVmDownloadConfig({ dataDirectory: root, envFile,
    environment: { CODEX_VM_PMO_PYTHON_PATH: overridePython } });
  assert.equal(config.vmPmoPythonPath, overridePython);
  assert.equal(path.resolve(config.vmPmoRunRoot), runRoot);
  assert.equal(resolveVmDownloadConfig({ dataDirectory: root }).vmPmoPythonPath, undefined);
});
