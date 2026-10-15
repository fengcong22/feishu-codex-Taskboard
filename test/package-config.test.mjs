import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  loadPackageRegistry,
  normalizePackageRegistry,
} from "../src/package-config.mjs";

function trustedPackage(overrides = {}) {
  return {
    name: "演示 Auto-Cut",
    projectId: "auto-cut-demo",
    workspacePath: path.resolve("examples/harmless-auto-cut"),
    prompt: "执行无害演示流程。",
    state: "enabled",
    ...overrides,
  };
}

test("normalizes a versioned registry to enabled trusted package bindings", () => {
  const packages = normalizePackageRegistry({
    version: 1,
    packages: {
      "Auto-cut-demo": trustedPackage(),
      "Auto-cut-draft": trustedPackage({ projectId: "draft", state: "draft" }),
      "Auto-cut-disabled": trustedPackage({ projectId: "disabled", state: "disabled" }),
    },
  });
  assert.deepEqual(Object.keys(packages), ["Auto-cut-demo"]);
  assert.deepEqual(packages["Auto-cut-demo"], {
    projectId: "auto-cut-demo",
    projectName: "演示 Auto-Cut",
    workspacePath: path.normalize(path.resolve("examples/harmless-auto-cut")),
    prompt: "执行无害演示流程。",
    resourceGroups: [],
  });
});

test("retains normalized resource groups for enabled package bindings", () => {
  const packages = normalizePackageRegistry({
    version: 1,
    packages: {
      "Auto-cut-resource-groups": trustedPackage({
        projectId: "resource-groups",
        resourceGroups: [" 剪映主机 ", "音频工作站", "剪映主机", "  "],
      }),
    },
  });

  assert.deepEqual(packages["Auto-cut-resource-groups"].resourceGroups, ["剪映主机", "音频工作站"]);
});

test("accepts the legacy embedded package map while migrating to the registry", () => {
  const packages = normalizePackageRegistry({
    host: "127.0.0.1",
    packages: {
      "Auto-cut-legacy": trustedPackage({ projectId: "legacy" }),
    },
  });
  assert.equal(packages["Auto-cut-legacy"].projectId, "legacy");
});

test("requires an explicit state for versioned registry entries", () => {
  assert.throws(
    () => normalizePackageRegistry({ version: 1, packages: {
      "Auto-cut-missing-state": trustedPackage({ state: undefined }),
    } }),
    /state is required/,
  );
});

test("rejects reserved package aliases", () => {
  assert.throws(
    () => normalizePackageRegistry({ version: 1, packages: {
      ["__proto__"]: trustedPackage({ alias: "__proto__" }),
    } }),
    /alias is invalid/,
  );
});

test("rejects unsafe enabled package bindings and duplicate project ids", () => {
  assert.throws(
    () => normalizePackageRegistry({ packages: {
      "Auto-cut-relative": trustedPackage({ workspacePath: "relative/path" }),
    } }),
    /workspacePath must be absolute/,
  );
  assert.throws(
    () => normalizePackageRegistry({ packages: {
      "Auto-cut-a": trustedPackage(),
      "Auto-cut-b": trustedPackage({ projectId: "auto-cut-demo" }),
    } }),
    /duplicate package projectId/,
  );
});

test("loadPackageRegistry fails closed for missing and malformed files", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "feishu-package-registry-"));
  const filename = path.join(directory, "packages.json");
  try {
    await assert.rejects(
      () => loadPackageRegistry(filename),
      (error) => error.code === "PACKAGE_REGISTRY_NOT_FOUND",
    );
    await mkdir(directory, { recursive: true });
    await writeFile(filename, "{not-json", "utf8");
    await assert.rejects(
      () => loadPackageRegistry(filename),
      (error) => error.code === "PACKAGE_REGISTRY_INVALID",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

const vmTemplate = { id: "vm_pmo_review_video", version: 1 };

async function vmRegistryFixture(t, declaration = vmTemplate) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "feishu-vm-registry-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const workspacePath = path.join(directory, "package");
  await mkdir(workspacePath);
  const manifestPath = path.join(workspacePath, "PACKAGE-MANIFEST.json");
  await writeFile(manifestPath, JSON.stringify({ interface: { workflowTemplate: vmTemplate } }));
  const entry = trustedPackage({ workspacePath });
  if (declaration !== undefined) entry.workflowTemplate = declaration;
  const registryPath = path.join(directory, "packages.json");
  await writeFile(registryPath, JSON.stringify({ version: 1, packages: { "auto-cut-slicing": entry } }));
  return { directory, workspacePath, manifestPath, registryPath, entry };
}

test("VM registry acceptance requires explicit host opt-in and a matching live manifest", async t => {
  const { registryPath } = await vmRegistryFixture(t);
  await assert.rejects(() => loadPackageRegistry(registryPath), { code: "PACKAGE_WORKFLOW_NOT_READY" });
  const packages = await loadPackageRegistry(registryPath, { allowVmInitial: true });
  assert.deepEqual(packages["auto-cut-slicing"].workflowTemplate, vmTemplate);
});

test("registry data cannot opt in to VM execution", () => {
  for (const option of [undefined, { allowVmInitial: "true" }, { allowVmInitial: 1 }]) {
    assert.throws(() => normalizePackageRegistry({ version: 1, allowVmInitial: true,
      packages: { "auto-cut-slicing": trustedPackage({ workflowTemplate: vmTemplate, allowVmInitial: true }) },
    }, option), { code: "PACKAGE_WORKFLOW_NOT_READY" });
  }
});

test("host VM opt-in cannot infer VM identity from an undeclared registry", async t => {
  const { registryPath, entry } = await vmRegistryFixture(t);
  delete entry.workflowTemplate;
  await writeFile(registryPath, JSON.stringify({ version: 1, packages: { "auto-cut-slicing": entry } }));
  await assert.rejects(() => loadPackageRegistry(registryPath, { allowVmInitial: true }),
    { code: "PACKAGE_WORKFLOW_NOT_READY" });
});

test("host VM opt-in rejects missing, malformed and changed manifests", async t => {
  const { registryPath, manifestPath } = await vmRegistryFixture(t);
  for (const [content, code] of [["{bad-json", "PACKAGE_MANIFEST_INVALID"],
    [JSON.stringify({ interface: { workflowTemplate: { id: "document_draft_zip", version: 1 } } }), "PACKAGE_WORKFLOW_MISMATCH"],
    [JSON.stringify({ interface: { workflowTemplate: vmTemplate, artifactKind: "zip" } }), "PACKAGE_WORKFLOW_UNSUPPORTED"]]) {
    await writeFile(manifestPath, content);
    await assert.rejects(() => loadPackageRegistry(registryPath, { allowVmInitial: true }), { code });
  }
  await rm(manifestPath);
  await assert.rejects(() => loadPackageRegistry(registryPath, { allowVmInitial: true }),
    { code: "PACKAGE_MANIFEST_UNAVAILABLE" });
});

test("host VM opt-in rejects a linked package workspace", async t => {
  const { directory, workspacePath, registryPath, entry } = await vmRegistryFixture(t);
  const linked = path.join(directory, "linked-package");
  await symlink(workspacePath, linked, process.platform === "win32" ? "junction" : "dir");
  await writeFile(registryPath, JSON.stringify({ version: 1, packages: {
    "auto-cut-slicing": { ...entry, workspacePath: linked },
  } }));
  await assert.rejects(() => loadPackageRegistry(registryPath, { allowVmInitial: true }),
    { code: "PACKAGE_WORKSPACE_UNAVAILABLE" });
});
