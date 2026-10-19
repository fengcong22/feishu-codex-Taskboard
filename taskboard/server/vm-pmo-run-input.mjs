import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { packageWorkflowFromManifest } from "../shared/feishu-package-workflow.mjs";
import { resolveVmStageFilename } from "./feishu-vm-delivery-plan.mjs";

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/u;
const EVENT_ID = /^[A-Za-z0-9][A-Za-z0-9_:-]{0,511}$/u;
const sha = value => createHash("sha256").update(value).digest("hex");
function fail(code) { const error = new Error(code); error.code = code; throw error; }
async function canonical(target, directory = false) {
  if (typeof target !== "string" || !path.isAbsolute(target) || path.normalize(target) !== target
    || await realpath(target) !== target) fail("VM_PMO_INPUT_PATH_INVALID");
  const info = await lstat(target);
  if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile() || info.nlink !== 1))
    fail("VM_PMO_INPUT_PATH_INVALID");
  return info;
}

async function canonicalParent(target) {
  let current = path.dirname(target);
  const chain = [];
  while (true) {
    let info;
    try { info = await lstat(current); } catch (error) {
      if (error?.code !== "ENOENT") fail("VM_PMO_INPUT_PATH_INVALID");
      const parent = path.dirname(current);
      if (parent === current) fail("VM_PMO_INPUT_PATH_INVALID");
      current = parent;
      continue;
    }
    chain.push(current);
    if (info.isSymbolicLink() || !info.isDirectory() || await realpath(current) !== current)
      fail("VM_PMO_INPUT_PATH_INVALID");
    break;
  }
  return chain;
}
async function immutableJson(target, value) {
  const bytes = Buffer.from(JSON.stringify(value, null, 2) + "\n");
  try { await writeFile(target, bytes, {flag: "wx"}); }
  catch (error) { if (error?.code !== "EEXIST") throw error; }
  await canonical(target);
  if (!(await readFile(target)).equals(bytes)) fail("VM_PMO_INPUT_SNAPSHOT_CONFLICT");
  return sha(bytes);
}

/** All descriptors must come from registered origin, frozen profile, and verified acquisition. */
export async function prepareVmPmoRunInput({ runRoot, runId, taskId, origin, profile,
  packageSnapshot, packageIdentity, acquisition, pythonPath, planAttempt = 1 } = {}) {
  const contextValue = origin?.stageSnapshot?.vmContext;
  const stageId = origin?.stageId;
  const review = stageId === "review";
  const reviewParent = origin?.stageSnapshot?.reviewParent;
  const instructionFieldId = profile?.stages?.[stageId]?.instructionFieldId;
  if (![runId, taskId, origin?.baseToken, origin?.tableId, origin?.recordId,
    profile?.fields?.outputAttachmentFieldId, profile?.fields?.namingFieldId,
    instructionFieldId].every(value => typeof value === "string" && ID.test(value))
    || typeof origin?.eventId !== "string" || !EVENT_ID.test(origin.eventId)
    || origin.source !== "feishu-base" || origin.packageSource !== "subject-config"
    || origin.deliverySource !== undefined || !["initial", "review"].includes(stageId)
    || origin.subjectKey !== `${origin.baseToken}:${origin.tableId}`
    || !Number.isSafeInteger(origin.configVersion) || origin.configVersion < 1
    || packageSnapshot?.workflowTemplate?.id !== "vm_pmo_review_video"
    || packageSnapshot.workflowTemplate.version !== 1 || packageSnapshot.packageAlias !== origin.packageAlias
    || typeof contextValue?.vmid !== "string" || !ID.test(contextValue.vmid)
    || typeof contextValue?.instruction !== "string" || !contextValue.instruction.trim()
    || contextValue.instruction.length > 16384 || contextValue.instruction.includes("\0")
    || !/^[a-f0-9]{64}$/u.test(acquisition.sha256)
    || !Number.isSafeInteger(acquisition.bytes) || acquisition.bytes < 1
    || !Number.isSafeInteger(acquisition.duration_ms) || acquisition.duration_ms < 1
    || typeof pythonPath !== "string" || !path.isAbsolute(pythonPath)
    || !Number.isSafeInteger(planAttempt) || planAttempt < 1 || planAttempt > 3)
    fail("VM_PMO_INPUT_UNTRUSTED");
  if (!review && (acquisition.vmid_binding !== "vm_api_verified"
    || (acquisition.vmid !== undefined && acquisition.vmid !== contextValue.vmid)))
    fail("VM_PMO_INPUT_UNTRUSTED");
  if (review && (!reviewParent || acquisition.vmid_binding !== "managed_review_parent"
    || reviewParent.runId === runId || !ID.test(reviewParent.runId) || !ID.test(reviewParent.artifactId)
    || !ID.test(reviewParent.deliveryId) || reviewParent.localPath !== acquisition.path
    || reviewParent.sha256 !== acquisition.sha256 || reviewParent.bytes !== acquisition.bytes
    || reviewParent.durationMs !== acquisition.duration_ms
    || reviewParent.reviewRound + 1 !== origin.stageSnapshot.reviewRound
    || !Number.isSafeInteger(origin.stageSnapshot.reviewRound) || origin.stageSnapshot.reviewRound < 1
    || (acquisition.vmid !== undefined && acquisition.vmid !== contextValue.vmid)))
    fail("VM_PMO_REVIEW_PARENT_INVALID");
  const sourceBefore = await canonical(acquisition.path);
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(acquisition.path)) hash.update(chunk);
  const sourceAfter = await canonical(acquisition.path);
  if (sourceBefore.size !== acquisition.bytes || hash.digest("hex") !== acquisition.sha256
    || sourceBefore.ino !== sourceAfter.ino || sourceBefore.mtimeMs !== sourceAfter.mtimeMs
    || sourceBefore.ctimeMs !== sourceAfter.ctimeMs) fail("VM_PMO_SOURCE_CHANGED");
  const packageRoot = packageSnapshot.workspacePath;
  await canonical(packageRoot, true);
  const manifestPath = path.join(packageRoot, "PACKAGE-MANIFEST.json");
  await canonical(manifestPath);
  const manifestBytes = await readFile(manifestPath);
  let manifest;
  try { manifest = JSON.parse(manifestBytes.toString("utf8")); }
  catch { fail("VM_PMO_PACKAGE_INVALID"); }
  let workflow;
  try { workflow = packageWorkflowFromManifest(manifest.interface); } catch { fail("VM_PMO_PACKAGE_INVALID"); }
  if (workflow.id !== "vm_pmo_review_video" || typeof manifest.name !== "string"
    || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(manifest.name)
    || typeof manifest.version !== "string" || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(manifest.version)) fail("VM_PMO_PACKAGE_INVALID");
  const manifestSha256 = sha(manifestBytes);
  const contractVersion = packageIdentity?.contractVersion ?? 1;
  if (![1, 2].includes(contractVersion)
    || contractVersion === 2 && (packageIdentity?.driverId !== "vm_pmo_review_video_v2"
      || manifest.interface?.contract?.id !== "vm_pmo_review_video"
      || manifest.interface?.contract?.version !== 2
      || manifest.interface?.driverId !== "vm_pmo_review_video_v2")
    || review && contractVersion !== 2) fail("VM_PMO_REVIEW_PROTOCOL_REQUIRED");
  if (packageIdentity !== undefined) {
    if (!packageIdentity || packageIdentity.name !== manifest.name || packageIdentity.version !== manifest.version
      || packageIdentity.manifestSha256 !== manifestSha256) fail("VM_PMO_PACKAGE_CHANGED");
  }
  const outputFilename = resolveVmStageFilename({config: profile,stageId,
    metadata: {fields: [{fieldId: profile.fields.namingFieldId,type: 1,uiType: "Text"}]},
    fields: {[profile.fields.namingFieldId]: contextValue.title},
    ...(review ? {reviewRound: origin.stageSnapshot.reviewRound} : {})});
  const schemaVersion = contractVersion === 2 ? 2 : 1;
  if (typeof runRoot !== "string" || !path.isAbsolute(runRoot) || path.normalize(runRoot) !== runRoot)
    fail("VM_PMO_INPUT_PATH_INVALID");
  await canonicalParent(runRoot);
  await mkdir(runRoot, {recursive: true});
  await canonical(runRoot, true);
  const baseRunDir = path.join(runRoot, runId);
  await mkdir(baseRunDir, {recursive: true});
  await canonical(baseRunDir, true);
  const runDir = path.join(baseRunDir, `attempt-${planAttempt}`);
  await mkdir(runDir, {recursive: true});
  await canonical(runDir, true);
  const input = {
    protocol: "vm_pmo_review_video",schema_version: schemaVersion,
    package: {alias: packageSnapshot.packageAlias,name: manifest.name,version: manifest.version,manifest_sha256: manifestSha256},
    binding: {task_id: taskId,run_id: runId,subject_key: origin.subjectKey,config_version: String(origin.configVersion),
      stage_id: stageId,event_id: origin.eventId},
    record: {base_token: origin.baseToken,table_id: origin.tableId,record_id: origin.recordId},
    review_round: {round_id: `round-${runId}`,input_snapshot_id: `snapshot-${runId}`,
      parent: review ? {kind: "managed_run",run_id: reviewParent.runId,artifact_id: reviewParent.artifactId,
        delivery_id: reviewParent.deliveryId,sha256: reviewParent.sha256,bytes: reviewParent.bytes,
        duration_ms: reviewParent.durationMs} : null},
    source: {source_id: "source-1",timeline_basis: review ? "previous_review_video" : "vm_original",vmid: contextValue.vmid,
      sha256: acquisition.sha256,bytes: acquisition.bytes,duration_ms: acquisition.duration_ms},
    instructions: [{instruction_id: "instruction-1",source_field_id: instructionFieldId,
      raw_text: contextValue.instruction,timeline_basis: review ? "previous_review_video" : "vm_original",applicability: "current_round"}],
    output_profile: {id: "review_mp4_v1",width: 1920,height: 1080,fps: 25,audio: "preserve"},
    delivery_target: {attachment_field_id: profile.fields.outputAttachmentFieldId},
  };
  const inputSha256 = await immutableJson(path.join(runDir, "input.json"), input);
  const contextPath = path.join(runDir, "execution-context.json");
  await immutableJson(contextPath, {protocol: input.protocol,schema_version: input.schema_version,input_sha256: inputSha256,
    run_dir: runDir,source_path: acquisition.path,plan_path: path.join(runDir, "plan.json"),
    plan_result_path: path.join(runDir, "plan-result.json"),result_path: path.join(runDir, "result.json"),
    output_path: path.join(runDir, outputFilename)});
  return {contextPath,inputSha256,outputFilename,runnerOptions: {pythonPath,packageRoot,contextPath}};
}
