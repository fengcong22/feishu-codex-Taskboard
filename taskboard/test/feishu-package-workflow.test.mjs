import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  assertPackageWorkflowExecutable, normalizePackageWorkflowTemplate, packageWorkflowFromManifest,
  PackageWorkflowError, workflowTemplatesEqual,
} from "../shared/feishu-package-workflow.mjs";
import {
  assertExecutablePackageWorkflow, inspectAutoCutPackageWorkspace, resolvePackageWorkflowFromWorkspace,
} from "../server/feishu-package-identity.mjs";
import { createFeishuPackageStore, normalizeFeishuPackages } from "../server/feishu-package-config.mjs";
import { createFeishuPackageApi } from "../server/feishu-package-api.mjs";
import { loadPackageRegistry, normalizePackageRegistry } from "../../src/package-config.mjs";

const LEGACY = { id: "document_draft_zip", version: 1 };
const VM = { id: "vm_pmo_review_video", version: 1 };
const VM_INTERFACE = {
  workflowTemplate: VM, contract: VM, driverId: "vm_pmo_review_video_v1", artifactKind: "review_mp4",
};
const VM_INTERFACE_V2 = {
  workflowTemplate: VM, contract: { id: VM.id, version: 2 },
  driverId: "vm_pmo_review_video_v2", artifactKind: "review_mp4",
};
const ROOT = "/api/local/autocut/packages";
const code = (expected) => (error) => error.code === expected && error.status === 409;

async function fixture(t, packageInterface, options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "package-workflow-"));
  const workspacePath = path.join(directory, "workspace");
  await mkdir(path.join(workspacePath, ".codex-plugin"), { recursive: true });
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(path.join(workspacePath, ".codex-plugin", "plugin.json"), JSON.stringify({
    name: "fixture-package", version: "1.2.3",
  }));
  const manifestPath = path.join(workspacePath, "PACKAGE-MANIFEST.json");
  const writeManifest = (value) => writeFile(manifestPath, JSON.stringify({ embedded_runtime: { version: "2.0.0" }, interface: value }));
  await writeManifest(packageInterface);
  const filename = path.join(directory, "registry.json");
  const store = createFeishuPackageStore({ filename, modelCatalog: { models: [{ slug: "fixture", supportedReasoningEfforts: ["high"] }] }, ...options });
  const api = createFeishuPackageApi({ store, getModelCatalog: () => assert.fail("VM cannot request a model catalog on enable") });
  return { directory, workspacePath, manifestPath, writeManifest, filename, store, api };
}

test("workflow declarations default only when absent and accept exact built-in versions", () => {
  assert.deepEqual(normalizePackageWorkflowTemplate(), LEGACY);
  assert.deepEqual(normalizePackageWorkflowTemplate(LEGACY), LEGACY);
  assert.deepEqual(normalizePackageWorkflowTemplate(VM), VM);
  assert.equal(workflowTemplatesEqual(undefined, LEGACY), true);
  assert.equal(workflowTemplatesEqual(undefined, VM), false);
  assert.deepEqual(assertPackageWorkflowExecutable(), LEGACY);
  assert.throws(() => assertPackageWorkflowExecutable(VM), code("PACKAGE_WORKFLOW_NOT_READY"));
  for (const value of [null, [], "vm_pmo_review_video", {}, { id: VM.id }, { version: 1 },
    { ...VM, version: "1" }, { ...VM, version: 2 }, { ...VM, id: "unknown" }, { ...VM, extra: true }]) {
    assert.throws(() => normalizePackageWorkflowTemplate(value), code("PACKAGE_WORKFLOW_UNSUPPORTED"));
  }
  const value = normalizePackageWorkflowTemplate();
  value.id = "mutated";
  assert.deepEqual(normalizePackageWorkflowTemplate(), LEGACY);
});

test("manifest validates optional contract, driver and artifact signals without unsafe legacy fallback", () => {
  assert.deepEqual(packageWorkflowFromManifest(), LEGACY);
  assert.deepEqual(packageWorkflowFromManifest({ zipOutput: { relativeDirectory: "out" } }), LEGACY);
  assert.deepEqual(packageWorkflowFromManifest({ artifactKind: "zip" }), LEGACY);
  assert.deepEqual(packageWorkflowFromManifest({ workflowTemplate: VM }), VM);
  assert.deepEqual(packageWorkflowFromManifest(VM_INTERFACE), VM);
  assert.deepEqual(packageWorkflowFromManifest(VM_INTERFACE_V2), VM);
  const invalid = [
    null, false, [], "raw", { workflowTemplate: null },
    { contract: VM }, { driverId: VM_INTERFACE.driverId }, { artifactKind: "review_mp4" },
    { workflowTemplate: LEGACY, contract: LEGACY }, { workflowTemplate: LEGACY, driverId: "document_draft_zip_v1" },
    { ...VM_INTERFACE, contract: { id: VM.id } },
    { ...VM_INTERFACE_V2, driverId: VM_INTERFACE.driverId },
    { ...VM_INTERFACE, contract: LEGACY }, { ...VM_INTERFACE, driverId: "unknown" },
    { ...VM_INTERFACE, driverId: null }, { ...VM_INTERFACE, artifactKind: "zip" },
  ];
  for (const value of invalid) assert.throws(() => packageWorkflowFromManifest(value), code("PACKAGE_WORKFLOW_UNSUPPORTED"));
  const error = new PackageWorkflowError("raw-secret https://private.example");
  assert.equal(error.code, "PACKAGE_WORKFLOW_UNSUPPORTED");
  assert.doesNotMatch(error.message, /raw-secret|https:/u);
});

test("normalization retains missing legacy identity and allows readable VM drafts or disabled recovery records", () => {
  const records = normalizeFeishuPackages({ version: 1, packages: {
    legacy: { state: "draft" }, vm: { state: "draft", workflowTemplate: VM },
    disabled: { state: "disabled", workflowTemplate: VM }, enabled: { state: "enabled", workflowTemplate: VM },
  } });
  assert.equal(Object.hasOwn(records.legacy, "workflowTemplate"), false);
  for (const alias of ["vm", "disabled", "enabled"]) assert.deepEqual(records[alias].workflowTemplate, VM);
  for (const entry of [{ workflowTemplate: { id: "unknown", version: 1 } }, { driverId: VM_INTERFACE.driverId }]) {
    assert.throws(() => normalizeFeishuPackages({ version: 1, packages: { invalid: { state: "draft", ...entry } } }),
      code("PACKAGE_WORKFLOW_UNSUPPORTED"));
  }
});

test("inspection always reports the resolved template and VM needs no ZIP declaration", async (t) => {
  const fixtureValue = await fixture(t, VM_INTERFACE);
  const inspected = await inspectAutoCutPackageWorkspace({ workspacePath: fixtureValue.workspacePath });
  assert.deepEqual(inspected.workflowTemplate, VM);
  assert.equal(inspected.zipOutput, null);
  await fixtureValue.writeManifest(undefined);
  assert.deepEqual((await inspectAutoCutPackageWorkspace({ workspacePath: fixtureValue.workspacePath })).workflowTemplate, LEGACY);
});

test("VM manifest is derived on draft save even when omitted by the API and cannot enable", async (t) => {
  const { api, filename, store, workspacePath } = await fixture(t, VM_INTERFACE);
  const saved = await api.handle({ method: "POST", pathname: ROOT, body: { alias: "vm", workspacePath } });
  assert.equal(saved.status, 201);
  assert.equal(saved.body.package.state, "draft");
  assert.equal(saved.body.package.model, null);
  assert.equal(saved.body.package.zipSourceDirectory, null);
  assert.deepEqual(saved.body.package.workflowTemplate, VM);
  assert.deepEqual(JSON.parse(await readFile(filename, "utf8")).packages.vm.workflowTemplate, VM);
  assert.deepEqual((await store.snapshot("vm")).workflowTemplate, VM);
  const listed = await api.handle({ method: "GET", pathname: ROOT });
  assert.deepEqual(listed.body.packages[0].identity.workflowTemplate, VM);
  await assert.rejects(() => api.handle({ method: "POST", pathname: `${ROOT}/vm/enable`, body: { revision: saved.body.package.revision } }),
    code("PACKAGE_WORKFLOW_NOT_READY"));
  assert.equal((await store.get("vm")).revision, 1);
  assert.equal((await store.get("vm")).state, "draft");
  await assert.rejects(() => api.handle({ method: "POST", pathname: `${ROOT}/prepare-output-directory`, body: { workspacePath } }),
    code("PACKAGE_WORKFLOW_NOT_READY"));
  await assert.rejects(() => stat(path.join(workspacePath, "output")), { code: "ENOENT" });
});

test("only a trusted VM readiness callback enables its dedicated package path", async t => {
  let ready = false;
  let checks = 0;
  const { api, store, workspacePath, writeManifest } = await fixture(t, VM_INTERFACE, {
    validateVmPackage: async record => { checks++; assert.equal(record.workflowTemplate.id, VM.id); return ready; },
  });
  const saved = await store.saveDraft({alias: "vm", workspacePath, prompt: "fixed offline driver"});
  await assert.rejects(store.enable("vm", saved.revision), code("PACKAGE_WORKFLOW_NOT_READY"));
  assert.equal((await store.get("vm")).state, "draft");
  ready = true;
  const enabled = await api.handle({method: "POST", pathname: `${ROOT}/vm/enable`, body: {revision: saved.revision}});
  assert.equal(enabled.body.package.state, "enabled");
  assert.equal(enabled.body.package.model, null);
  assert.equal(checks, 2);
  await assert.rejects(assertExecutablePackageWorkflow(enabled.body.package), code("PACKAGE_WORKFLOW_NOT_READY"));
  await assert.rejects(store.withEnabledPackage("vm", () => assert.fail("legacy restore must reject VM")), code("PACKAGE_WORKFLOW_NOT_READY"));
  await writeManifest({workflowTemplate: LEGACY});
  await assert.rejects(store.enable("vm", enabled.body.package.revision), code("PACKAGE_WORKFLOW_MISMATCH"));
});

test("API permits explicit VM draft identity and translates unsupported or mismatching declarations", async (t) => {
  const { api, workspacePath } = await fixture(t, VM_INTERFACE);
  const saved = await api.handle({ method: "POST", pathname: ROOT, body: { alias: "vm-explicit", workflowTemplate: VM, workspacePath } });
  assert.deepEqual(saved.body.package.workflowTemplate, VM);
  await assert.rejects(() => api.handle({ method: "POST", pathname: ROOT, body: { alias: "wrong", workflowTemplate: LEGACY, workspacePath } }),
    code("PACKAGE_WORKFLOW_MISMATCH"));
  await assert.rejects(() => api.handle({ method: "POST", pathname: ROOT, body: { alias: "unknown", workflowTemplate: { id: "private-secret", version: 1 } } }),
    (error) => error.code === "PACKAGE_WORKFLOW_UNSUPPORTED" && error.status === 409 && !error.message.includes("private-secret"));
});

test("persisted template cannot be changed or removed through a patch or a new workspace", async (t) => {
  const { store, workspacePath, writeManifest } = await fixture(t, undefined);
  const legacy = await store.saveDraft({ alias: "legacy", workspacePath });
  assert.equal(Object.hasOwn(legacy, "workflowTemplate"), false);
  await assert.rejects(() => store.saveDraft("legacy", { workflowTemplate: VM }, legacy.revision), code("PACKAGE_IDENTITY_IMMUTABLE"));
  await writeManifest(VM_INTERFACE);
  await assert.rejects(() => store.saveDraft("legacy", { prompt: "edited" }, legacy.revision), code("PACKAGE_IDENTITY_IMMUTABLE"));
  const vm = await store.saveDraft({ alias: "new-vm", workspacePath });
  await assert.rejects(() => store.saveDraft("new-vm", { workflowTemplate: undefined }, vm.revision), code("PACKAGE_IDENTITY_IMMUTABLE"));
  assert.deepEqual((await store.get("new-vm")).workflowTemplate, VM);
  assert.equal((await store.get("legacy")).revision, legacy.revision);
});

test("existing legacy workspace without manifest remains executable; declared or malformed save cannot silently downgrade", async (t) => {
  const { manifestPath, store, workspacePath } = await fixture(t, undefined);
  await rm(manifestPath);
  const saved = await store.saveDraft({ alias: "legacy", workspacePath, model: "fixture", reasoningEffort: "high", prompt: "fixture" });
  const enabled = await store.enable(saved.alias, saved.revision);
  assert.equal(enabled.state, "enabled");
  assert.equal(Object.hasOwn(enabled, "workflowTemplate"), false);
  assert.deepEqual(await assertExecutablePackageWorkflow({ workspacePath, workflowTemplate: LEGACY }), LEGACY);
  await assert.rejects(() => store.saveDraft({ alias: "declared-missing", workspacePath, workflowTemplate: LEGACY }),
    code("PACKAGE_MANIFEST_UNAVAILABLE"));
  await writeFile(manifestPath, "{ private-secret");
  await assert.rejects(() => store.saveDraft({ alias: "malformed", workspacePath }), code("PACKAGE_MANIFEST_INVALID"));
  await assert.rejects(() => assertExecutablePackageWorkflow(enabled), code("PACKAGE_MANIFEST_INVALID"));
});

test("live execution check rejects manifest changes and local config cannot enable a preview workflow", async (t) => {
  const { workspacePath, writeManifest } = await fixture(t, VM_INTERFACE);
  for (const record of [{ workspacePath }, { workspacePath, workflowTemplate: VM }, { workspacePath, workflowTemplate: LEGACY }]) {
    await assert.rejects(() => assertExecutablePackageWorkflow(record), (error) =>
      ["PACKAGE_WORKFLOW_NOT_READY", "PACKAGE_WORKFLOW_MISMATCH"].includes(error.code));
  }
  const store = createFeishuPackageStore({ packages: { vm: { state: "enabled", workspacePath, workflowTemplate: VM } } });
  await assert.rejects(() => store.enable("vm", 1), code("PACKAGE_WORKFLOW_NOT_READY"));
  await assert.rejects(() => store.withEnabledPackage("vm", () => assert.fail("preview must not reach operation")), code("PACKAGE_WORKFLOW_NOT_READY"));
  await writeManifest({ driverId: VM_INTERFACE.driverId });
  await assert.rejects(() => resolvePackageWorkflowFromWorkspace({ workspacePath }), code("PACKAGE_WORKFLOW_UNSUPPORTED"));
});

test("Bridge rejects enabled preview or unknown declarations and rereads actual manifest when declaration omitted", async (t) => {
  const { workspacePath, filename, writeManifest } = await fixture(t, VM_INTERFACE);
  const entry = { state: "enabled", projectId: "fixture", workspacePath, prompt: "fixture" };
  for (const fields of [{ workflowTemplate: VM }, { workflowTemplate: { id: "unknown", version: 1 } }, { driverId: VM_INTERFACE.driverId }]) {
    assert.throws(() => normalizePackageRegistry({ version: 1, packages: { pkg: { ...entry, ...fields } } }),
      (error) => ["PACKAGE_WORKFLOW_NOT_READY", "PACKAGE_WORKFLOW_UNSUPPORTED"].includes(error.code));
  }
  assert.deepEqual(normalizePackageRegistry({ version: 1, packages: { vm: { ...entry, workflowTemplate: VM, state: "draft" } } }), {});
  await writeFile(filename, JSON.stringify({ version: 1, packages: { pkg: entry } }));
  await assert.rejects(() => loadPackageRegistry(filename), code("PACKAGE_WORKFLOW_NOT_READY"));
  await writeManifest(undefined);
  const legacy = await loadPackageRegistry(filename);
  assert.equal(Object.hasOwn(legacy.pkg, "workflowTemplate"), false);
  const declared = normalizePackageRegistry({ version: 1, packages: { pkg: { ...entry, workflowTemplate: LEGACY } } });
  assert.deepEqual(declared.pkg.workflowTemplate, LEGACY);
});

test("repository VM preview fixture reports no embedded runtime and cannot be enabled", async () => {
  const workspacePath = fileURLToPath(new URL("../../examples/vm-pmo-review-video-preview/", import.meta.url));
  const inspection = await inspectAutoCutPackageWorkspace({ workspacePath });
  assert.deepEqual(inspection.workflowTemplate, VM);
  assert.equal(inspection.pluginVersion, "0.1.0");
  assert.equal(inspection.runtimeVersion, null);
  assert.equal(inspection.zipOutput, null);
  const store = createFeishuPackageStore({ packages: {} });
  const saved = await store.saveDraft({ alias: inspection.alias, workspacePath });
  await assert.rejects(() => store.enable(saved.alias, saved.revision), code("PACKAGE_WORKFLOW_NOT_READY"));
});
