import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { createFeishuPackageApi } from "../server/feishu-package-api.mjs";
import { createFeishuPackageStore } from "../server/feishu-package-config.mjs";

async function outputFixture(t, relativeDirectory = "output") {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-package-output-safety-"));
  const workspacePath = path.join(directory, "workspace");
  await mkdir(path.join(workspacePath, ".codex-plugin"), { recursive: true });
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(path.join(workspacePath, ".codex-plugin", "plugin.json"), JSON.stringify({
    name: "auto-cut-lite",
    version: "1.6.10",
  }));
  const writeDeclaration = (value) => writeFile(path.join(workspacePath, "PACKAGE-MANIFEST.json"), JSON.stringify({
    embedded_runtime: { version: "1.7.0" },
    interface: { zipOutput: value },
  }));
  await writeDeclaration({ relativeDirectory });
  const store = createFeishuPackageStore({ packages: {} });
  const api = createFeishuPackageApi({ store });
  return {
    directory,
    workspacePath,
    writeDeclaration,
    store,
    api,
    inspect: () => api.handle({ method: "POST", pathname: "/api/local/autocut/packages/inspect-workspace", body: { workspacePath } }),
    prepare: () => api.handle({ method: "POST", pathname: "/api/local/autocut/packages/prepare-output-directory", body: { workspacePath } }),
  };
}

test("ZIP output declaration rejects unsafe paths on every host platform", async (t) => {
  const fixture = await outputFixture(t);
  const invalidDeclarations = [
    null, false, "output", [], {}, { relativeDirectory: 7 },
    ...[
      "", "   ", ".", "..", "output/../escape", "output\\..\\escape", "output/./zip",
      "output//zip", "output\\\\zip", "output/", "output\\", "output\0zip",
      "/tmp/output", "\\output", "C:\\output", "C:/output", "C:output", "\\\\server\\share\\output",
      "output/.. /escape", "output./zip", "output ", "output.", "output/aux/zip", "output/CON.txt", "output:stream",
      "output?", "output*", "output<", "output>", "output|", 'output"', "output\nzip",
    ].map((relativeDirectory) => ({ relativeDirectory })),
  ];
  for (const declaration of invalidDeclarations) {
    await fixture.writeDeclaration(declaration);
    await assert.rejects(fixture.inspect, (error) => error.code === "PACKAGE_MANIFEST_INVALID", JSON.stringify(declaration));
    await assert.rejects(fixture.prepare, (error) => error.code === "PACKAGE_MANIFEST_INVALID", JSON.stringify(declaration));
  }
});

test("ZIP output declaration comes only from the package manifest", async (t) => {
  const fixture = await outputFixture(t, "package-output");
  await writeFile(path.join(fixture.workspacePath, ".codex-plugin", "plugin.json"), JSON.stringify({
    name: "auto-cut-lite",
    version: "1.6.10",
    interface: { zipOutput: { relativeDirectory: "plugin-output" } },
  }));
  assert.equal((await fixture.inspect()).body.inspection.zipOutput.relativeDirectory, "package-output");

  await fixture.writeDeclaration(undefined);
  assert.equal((await fixture.inspect()).body.inspection.zipOutput, null);
  await assert.rejects(fixture.prepare, (error) => error.code === "PACKAGE_ZIP_OUTPUT_UNDECLARED");
  await assert.rejects(() => stat(path.join(fixture.workspacePath, "plugin-output")), { code: "ENOENT" });
});

test("ZIP output preparation rejects a junction outside the workspace before creating children", async (t) => {
  const fixture = await outputFixture(t, "linked/zip");
  const outside = path.join(fixture.directory, "outside");
  await mkdir(outside);
  await symlink(outside, path.join(fixture.workspacePath, "linked"), process.platform === "win32" ? "junction" : "dir");

  await assert.rejects(fixture.prepare, (error) => error.code === "PACKAGE_ZIP_OUTPUT_UNSAFE");
  await assert.rejects(() => stat(path.join(outside, "zip")), { code: "ENOENT" });
  assert.deepEqual(await fixture.store.list(), []);
});

test("ZIP output preparation rereads the declaration and is idempotent", async (t) => {
  const fixture = await outputFixture(t, "first/output");
  assert.equal((await fixture.inspect()).body.inspection.zipOutput.relativeDirectory, "first/output");
  await fixture.writeDeclaration({ relativeDirectory: "second\\output" });

  const expected = {
    relativeDirectory: "second\\output",
    directory: path.join(fixture.workspacePath, "second", "output"),
  };
  assert.deepEqual((await fixture.prepare()).body.zipOutput, expected);
  assert.deepEqual((await fixture.prepare()).body.zipOutput, expected);
  assert.equal((await stat(expected.directory)).isDirectory(), true);
  await assert.rejects(() => stat(path.join(fixture.workspacePath, "first")), { code: "ENOENT" });
});

test("ZIP output preparation requires only an absolute workspace path", async (t) => {
  const fixture = await outputFixture(t);
  const pathname = "/api/local/autocut/packages/prepare-output-directory";
  await assert.rejects(
    () => fixture.api.handle({ method: "POST", pathname, body: { workspacePath: fixture.workspacePath, directory: fixture.directory } }),
    (error) => error.code === "UNKNOWN_FIELD",
  );
  await assert.rejects(
    () => fixture.api.handle({ method: "POST", pathname, body: { workspacePath: "relative" } }),
    (error) => error.code === "INVALID_FIELD",
  );
  await assert.rejects(
    () => fixture.api.handle({ method: "GET", pathname, body: null }),
    (error) => error.code === "METHOD_NOT_ALLOWED",
  );
  await assert.rejects(() => stat(path.join(fixture.workspacePath, "output")), { code: "ENOENT" });
});

test("custom output directory validation endpoint is read-only and whitelisted", async (t) => {
  const fixture = await outputFixture(t);
  const custom = path.join(fixture.directory, "custom");
  await mkdir(custom);
  const pathname = "/api/local/autocut/packages/validate-output-directory";
  const missing = path.join(fixture.directory, "missing");
  const response = await fixture.api.handle({ method: "POST", pathname, body: { directory: custom } });
  assert.deepEqual(response, { status: 200, body: { directory: path.normalize(custom) } });
  await assert.rejects(() => stat(path.join(custom, "created")), { code: "ENOENT" });
  await assert.rejects(
    () => fixture.api.handle({ method: "POST", pathname, body: { directory: missing } }),
    (error) => error.code === "PACKAGE_CUSTOM_ZIP_OUTPUT_INVALID",
  );
  await assert.rejects(() => stat(missing), { code: "ENOENT" });
  await assert.rejects(
    () => fixture.api.handle({ method: "POST", pathname, body: { directory: custom, extra: true } }),
    (error) => error.code === "UNKNOWN_FIELD",
  );
  await assert.rejects(
    () => fixture.api.handle({ method: "GET", pathname, body: null }),
    (error) => error.code === "METHOD_NOT_ALLOWED",
  );
});

test("package API persists the explicit ZIP output mode through POST and PATCH", async (t) => {
  const fixture = await outputFixture(t);
  const custom = path.join(fixture.directory, "custom");
  await mkdir(custom);
  const created = await fixture.api.handle({
    method: "POST",
    pathname: "/api/local/autocut/packages",
    body: {
      alias: "Auto-cut-api-custom",
      name: "API custom",
      projectId: "api-custom",
      zipOutputMode: "custom",
      zipSourceDirectory: custom,
    },
  });
  assert.equal(created.body.package.zipOutputMode, "custom");
  const patched = await fixture.api.handle({
    method: "PATCH",
    pathname: "/api/local/autocut/packages/Auto-cut-api-custom",
    body: { expectedRevision: created.body.package.revision, zipOutputMode: "package_default" },
  });
  assert.equal(patched.body.package.zipOutputMode, "package_default");
  await assert.rejects(
    () => fixture.api.handle({
      method: "PATCH",
      pathname: "/api/local/autocut/packages/Auto-cut-api-custom",
      body: { expectedRevision: patched.body.package.revision, zipOutputMode: "invalid" },
    }),
    (error) => error.code === "PACKAGE_INVALID",
  );
});
