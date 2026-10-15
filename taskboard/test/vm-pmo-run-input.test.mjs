import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import os from "node:os";
import { prepareVmPmoRunInput } from "../server/vm-pmo-run-input.mjs";

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "vm-input-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const packageRoot = path.join(root, "package");
  await mkdir(packageRoot);
  await writeFile(path.join(packageRoot, "PACKAGE-MANIFEST.json"), JSON.stringify({name: "auto-cut-slicing",version: "0.2.0",
    interface: {workflowTemplate: {id: "vm_pmo_review_video",version: 1}}}));
  const sourcePath = path.join(root, "source.mp4");
  await writeFile(sourcePath, "source");
  return { runRoot: path.join(root, "runs"), runId: "run-1", taskId: "task-1", pythonPath: path.join(root, "python.exe"),
    origin: {source: "feishu-base",packageSource: "subject-config",eventId: "event-1",baseToken: "base-1",tableId: "table-1",
      recordId: "record-1",subjectKey: "base-1:table-1",configVersion: 1,stageId: "initial",packageAlias: "slicing",
      stageSnapshot: {vmContext: {vmid: "vmid-1",title: "test/name",instruction: "0:00-0:20"}}},
    profile: {fields: {namingFieldId: "fld-name",outputAttachmentFieldId: "fld-output"},
      stages: {initial: {instructionFieldId: "fld-instruction"}}},
    packageSnapshot: {packageAlias: "slicing",workspacePath: packageRoot,workflowTemplate: {id: "vm_pmo_review_video",version: 1}},
    acquisition: {path: sourcePath,sha256: createHash("sha256").update("source").digest("hex"),bytes: 6,duration_ms: 25000,
      vmid_binding: "vm_api_verified",vmid: "vmid-1"} };
}

test("VM input freezes original instruction and approved source without copying media", async t => {
  const args = await fixture(t);
  const prepared = await prepareVmPmoRunInput(args);
  const context = JSON.parse(await readFile(prepared.contextPath, "utf8"));
  const input = JSON.parse(await readFile(path.join(context.run_dir, "input.json"), "utf8"));
  assert.equal(input.instructions[0].raw_text, "0:00-0:20");
  assert.equal(input.binding.task_id, args.taskId);
  assert.equal(input.source.sha256, args.acquisition.sha256);
  assert.equal(context.source_path, args.acquisition.path);
  assert.equal(path.dirname(context.output_path), context.run_dir);
  assert.equal(prepared.outputFilename, "test_name_初稿.mp4");
  assert.deepEqual(await prepareVmPmoRunInput(args), prepared);
  args.origin.stageSnapshot.vmContext.instruction = "0:10-0:20";
  await assert.rejects(prepareVmPmoRunInput(args), {code: "VM_PMO_INPUT_SNAPSHOT_CONFLICT"});
});

test("VM input rejects simulation and changed approved source before creating a run", async t => {
  const args = await fixture(t);
  args.origin.deliverySource = "simulation";
  await assert.rejects(prepareVmPmoRunInput(args), {code: "VM_PMO_INPUT_UNTRUSTED"});
  delete args.origin.deliverySource;
  await writeFile(args.acquisition.path, "changed");
  await assert.rejects(prepareVmPmoRunInput(args), {code: "VM_PMO_SOURCE_CHANGED"});
});

test("VM input accepts normalized composite event IDs and preserves raw instruction whitespace", async t => {
  const args = await fixture(t);
  args.origin.eventId = "evt:record:fld_status";
  args.origin.stageSnapshot.vmContext.instruction = "  0:00-0:20\n";
  const prepared = await prepareVmPmoRunInput(args);
  const input = JSON.parse(await readFile(path.join(path.dirname(prepared.contextPath), "input.json"), "utf8"));
  assert.equal(input.binding.event_id, "evt:record:fld_status");
  assert.equal(input.instructions[0].raw_text, "  0:00-0:20\n");
});

test("VM input honors a frozen package version and manifest digest", async t => {
  const args = await fixture(t);
  const filename = path.join(args.packageSnapshot.workspacePath, "PACKAGE-MANIFEST.json");
  const original = await readFile(filename);
  args.packageIdentity = { name: "auto-cut-slicing", version: "0.2.0", manifestSha256: createHash("sha256").update(original).digest("hex") };
  await writeFile(filename, JSON.stringify({ name: "auto-cut-slicing", version: "0.2.1",
    interface: { workflowTemplate: { id: "vm_pmo_review_video", version: 1 } } }));
  await assert.rejects(prepareVmPmoRunInput(args), { code: "VM_PMO_PACKAGE_CHANGED" });
  args.packageIdentity.version = "0.2.1";
  args.packageIdentity.manifestSha256 = createHash("sha256").update(await readFile(filename)).digest("hex");
  const prepared = await prepareVmPmoRunInput(args);
  const input = JSON.parse(await readFile(path.join(path.dirname(prepared.contextPath), "input.json"), "utf8"));
  assert.equal(input.package.version, "0.2.1");
  assert.equal(input.package.manifest_sha256, args.packageIdentity.manifestSha256);
});

test("VM input rejects a linked ancestor before creating a directory outside the configured root", async t => {
  const args = await fixture(t);
  const parent = path.dirname(args.runRoot);
  const realDirectory = path.join(parent, "outside");
  await mkdir(realDirectory);
  const linked = path.join(parent, "linked");
  try { await symlink(realDirectory, linked, process.platform === "win32" ? "junction" : "dir"); }
  catch (error) { if (["EPERM", "EACCES"].includes(error.code)) return t.skip("links are unavailable"); throw error; }
  args.runRoot = path.join(linked, "must-not-create");
  await assert.rejects(prepareVmPmoRunInput(args), { code: "VM_PMO_INPUT_PATH_INVALID" });
  await assert.rejects(stat(path.join(realDirectory, "must-not-create")), { code: "ENOENT" });
});
