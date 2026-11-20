import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { archiveVmPmoQa } from "../server/vm-pmo-qa-archive.mjs";

async function attempt(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "vm-qa-archive-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runDir = path.join(root, "run-1", "attempt-2");
  await mkdir(path.join(runDir, "qa-frames"), { recursive: true });
  const context = { run_dir: runDir, qa_path: path.join(runDir, "qa.json"),
    qa_review_path: path.join(runDir, "qa-review.json") };
  for (const name of ["qa-result.json", "qa.json", "qa-review-request.json", "output.words.json", "plan.json"])
    await writeFile(path.join(runDir, name), `{"name":"${name}"}`);
  await writeFile(path.join(runDir, "qa-frames", "t0us_after.png"), "png");
  return { root, runDir, context };
}

test("QA outputs move beside the attempts and the MP4's transcript stays", async (t) => {
  const { root, runDir, context } = await attempt(t);
  const target = await archiveVmPmoQa(context);
  assert.equal(target, path.join(root, "run-1", "qa-archive", "attempt-2-qa-1"));
  assert.deepEqual((await readdir(target)).sort(), ["qa-frames", "qa-result.json", "qa-review-request.json", "qa.json"]);
  assert.deepEqual((await readdir(runDir)).sort(), ["output.words.json", "plan.json"]);
  assert.equal(await readFile(path.join(target, "qa-frames", "t0us_after.png"), "utf8"), "png");
  // Called again after the move (the run was not queued), it finds the archive and moves nothing.
  assert.equal(await archiveVmPmoQa(context), target);
});

test("an archive is never overwritten and a run with no QA output is refused", async (t) => {
  const { root, context } = await attempt(t);
  const target = path.join(root, "run-1", "qa-archive", "attempt-2-qa-1");
  await mkdir(target, { recursive: true });
  await writeFile(path.join(target, "qa.json"), "earlier");
  await assert.rejects(archiveVmPmoQa(context), { code: "VM_PMO_RETRY_NOT_ALLOWED" });
  assert.equal(await readFile(path.join(target, "qa.json"), "utf8"), "earlier");

  const empty = await attempt(t);
  for (const name of ["qa-result.json", "qa.json", "qa-review-request.json"]) await rm(path.join(empty.runDir, name));
  await rm(path.join(empty.runDir, "qa-frames"), { recursive: true });
  await assert.rejects(archiveVmPmoQa(empty.context), { code: "VM_PMO_RETRY_NOT_ALLOWED" });
});
