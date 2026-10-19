import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, realpath, mkdir, readFile, writeFile, rm, symlink, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import os from "node:os";
import { prepareVmPmoRunInput } from "../server/vm-pmo-run-input.mjs";
import { validateVmPmoInput } from "../server/vm-pmo-result-validator.mjs";

async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "vm-input-")));
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

test("each planning attempt gets an independent immutable input directory", async t => {
  const args = await fixture(t);
  const first = await prepareVmPmoRunInput({...args,planAttempt: 1});
  const firstBytes = await readFile(first.contextPath);
  const firstContext = JSON.parse(firstBytes.toString("utf8"));
  const second = await prepareVmPmoRunInput({...args,planAttempt: 2});
  const secondContext = JSON.parse(await readFile(second.contextPath,"utf8"));

  assert.notEqual(first.contextPath,second.contextPath);
  assert.notEqual(firstContext.run_dir,secondContext.run_dir);
  assert.equal(firstContext.source_path,args.acquisition.path);
  assert.equal(secondContext.source_path,args.acquisition.path);
  assert.equal(first.inputSha256,second.inputSha256);
  assert.deepEqual(await readFile(first.contextPath),firstBytes);
});

test("initial v2 package emits and validates schema v2 input for semantic editing", async t => {
  const args = await fixture(t);
  const manifestPath = path.join(args.packageSnapshot.workspacePath, "PACKAGE-MANIFEST.json");
  await writeFile(manifestPath, JSON.stringify({ name: "auto-cut-slicing", version: "0.3.0",
    interface: { workflowTemplate: { id: "vm_pmo_review_video", version: 1 },
      contract: { id: "vm_pmo_review_video", version: 2 }, driverId: "vm_pmo_review_video_v2",
      artifactKind: "review_mp4" } }));
  args.packageIdentity = { name: "auto-cut-slicing", version: "0.3.0",
    manifestSha256: createHash("sha256").update(await readFile(manifestPath)).digest("hex"),
    contractVersion: 2, driverId: "vm_pmo_review_video_v2" };
  args.origin.stageSnapshot.vmContext.instruction = "0:06-（4:22 剪掉 ‘中学阶段’这几个字的声音，可以用停顿占位）-4:34";

  const prepared = await prepareVmPmoRunInput(args);
  const context = JSON.parse(await readFile(prepared.contextPath, "utf8"));
  const input = JSON.parse(await readFile(path.join(context.run_dir, "input.json"), "utf8"));
  assert.equal(input.binding.stage_id, "initial");
  assert.equal(input.schema_version, 2);
  assert.equal(context.schema_version, 2);
  assert.equal(input.instructions[0].raw_text, args.origin.stageSnapshot.vmContext.instruction);
  const bound = await validateVmPmoInput({ contextPath: prepared.contextPath });
  assert.equal(bound.input.schema_version, 2);
});

test("review input v2 binds the exact delivered parent and emits the persisted draft number", async t => {
  const args = await fixture(t);
  const manifestPath = path.join(args.packageSnapshot.workspacePath, "PACKAGE-MANIFEST.json");
  await writeFile(manifestPath, JSON.stringify({ name: "auto-cut-slicing", version: "0.3.0",
    interface: { workflowTemplate: { id: "vm_pmo_review_video", version: 1 },
      contract: { id: "vm_pmo_review_video", version: 2 }, driverId: "vm_pmo_review_video_v2",
      artifactKind: "review_mp4" } }));
  const bytes = await readFile(args.acquisition.path);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  args.origin.stageId = "review";
  args.origin.stageSnapshot = { vmContext: { vmid: "vmid-1", title: "test/name",
    instruction: "剪掉‘上一章’三个字", statusOptionId: "opt-review" }, reviewRound: 2,
    reviewParent: { runId: "parent-run", artifactId: "parent-artifact", deliveryId: "delivery-1",
      localPath: args.acquisition.path, sha256, bytes: bytes.length, durationMs: 25_000, reviewRound: 1 } };
  args.profile.stages.review = { instructionFieldId: "fld-review-instruction" };
  args.packageIdentity = { name: "auto-cut-slicing", version: "0.3.0",
    manifestSha256: createHash("sha256").update(await readFile(manifestPath)).digest("hex"),
    contractVersion: 2, driverId: "vm_pmo_review_video_v2" };
  args.acquisition = { path: args.acquisition.path, sha256, bytes: bytes.length,
    duration_ms: 25_000, vmid_binding: "managed_review_parent", vmid: "vmid-1" };

  const prepared = await prepareVmPmoRunInput(args);
  const context = JSON.parse(await readFile(prepared.contextPath, "utf8"));
  const input = JSON.parse(await readFile(path.join(context.run_dir, "input.json"), "utf8"));
  assert.equal(input.schema_version, 2);
  assert.equal(context.schema_version, 2);
  assert.equal(input.binding.stage_id, "review");
  assert.equal(input.review_round.parent.run_id, "parent-run");
  assert.equal(input.review_round.parent.sha256, sha256);
  assert.equal(input.source.timeline_basis, "previous_review_video");
  assert.equal(input.source.sha256, sha256);
  assert.equal(input.instructions[0].raw_text, "剪掉‘上一章’三个字");
  assert.equal(input.instructions[0].source_field_id, "fld-review-instruction");
  assert.equal(prepared.outputFilename, "test_name_第2稿.mp4");
  const bound = await validateVmPmoInput({ contextPath: prepared.contextPath });
  assert.equal(bound.input.binding.stage_id, "review");
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
