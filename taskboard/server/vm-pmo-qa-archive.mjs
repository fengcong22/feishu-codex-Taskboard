import { lstat, mkdir, readdir, rename } from "node:fs/promises";
import path from "node:path";

import { VM_PMO_QA_RESULT } from "./vm-pmo-result-validator.mjs";

function failure(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

async function present(file) {
  try { await lstat(file); return true; } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw failure("VM_PMO_RETRY_NOT_ALLOWED");
  }
}

/** The QA outputs of one attempt: the receipt, the report, its review request and exported frames,
 * and an AI picture review when one exists. The reverse ASR of the MP4 (output.words.json) is bound
 * to the unchanged MP4 and stays in place, so a rerun does not transcribe it again. */
function qaFiles(context) {
  const report = path.parse(context.qa_path);
  return [path.join(context.run_dir, VM_PMO_QA_RESULT), context.qa_path,
    path.join(report.dir, `${report.name}-review-request.json`), path.join(report.dir, `${report.name}-frames`),
    context.qa_review_path];
}

/** Moves one attempt's QA outputs beside the attempt directories, into
 * `<runRoot>/<runId>/qa-archive/<attempt>-qa-1/`. The archive directory is created exclusively, so an
 * earlier archive is never overwritten. A call after a completed move (the run was not queued yet)
 * finds no QA output and an archive that holds the receipt, and succeeds without moving anything. */
export async function archiveVmPmoQa(context) {
  const root = path.join(path.dirname(context.run_dir), "qa-archive");
  const target = path.join(root, `${path.basename(context.run_dir)}-qa-1`);
  const files = qaFiles(context);
  const existing = [];
  for (const file of files) if (await present(file)) existing.push(file);
  if (!existing.length) {
    if (await present(path.join(target, VM_PMO_QA_RESULT))) return target;
    throw failure("VM_PMO_RETRY_NOT_ALLOWED");
  }
  await mkdir(root, { recursive: true });
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink()) throw failure("VM_PMO_RETRY_NOT_ALLOWED");
  try { await mkdir(target); } catch (error) {
    // A partial earlier move may have left the archive; it is only reused if nothing there would be replaced.
    if (error?.code !== "EEXIST") throw failure("VM_PMO_RETRY_NOT_ALLOWED");
    const kept = new Set(await readdir(target));
    if (existing.some((file) => kept.has(path.basename(file)))) throw failure("VM_PMO_RETRY_NOT_ALLOWED");
  }
  for (const file of existing) await rename(file, path.join(target, path.basename(file)));
  return target;
}
