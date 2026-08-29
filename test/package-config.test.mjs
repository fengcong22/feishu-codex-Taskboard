import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
  });
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
