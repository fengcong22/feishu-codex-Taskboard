import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { link, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { TaskboardDatabase } from "../server/database.mjs";

const record = { baseToken: "bas_test", tableId: "tbl_test", recordId: "rec_test" };
const event = { eventId: "evt_archive_1", subjectKey: "bas_test:tbl_test", configVersion: 3, record,
  statusEdge: {statusFieldId: "fld_status",beforeOptionIds: ["opt_done"],afterOptionIds: ["opt_archive"]} };
const digest = (value) => createHash("sha256").update(value).digest("hex");

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "vm-final-archive-"));
  const database = new TaskboardDatabase(path.join(root, "state.sqlite"));
  t.after(async () => { database.close(); await rm(root, { recursive: true, force: true }); });
  const sourcePath = path.join(root, "source.mp4");
  const destinationDirectory = path.join(root, "archive");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(destinationDirectory);
  await writeFile(sourcePath, Buffer.from("verified mp4 bytes"));
  const sourceBytes = await readFile(sourcePath);
  const plan = (overrides = {}) => ({
    record,
    source: { deliveryId: "delivery_1", runId: "run_1", artifactId: "artifact_1",
      localPath: sourcePath, sha256: digest(sourceBytes), bytes: sourceBytes.length },
    filename: "课程.mp4",
    destinationDirectory,
    destinationPath: path.join(destinationDirectory, "课程.mp4"),
    canonicalLocationKey: path.join(destinationDirectory, "课程.mp4").toLowerCase(),
    ...overrides,
  });
  const load = async (options = {}) => {
    const module = await import("../server/vm-pmo-final-archive.mjs").catch((error) => ({ loadError: error }));
    assert.equal(typeof module.createVmFinalArchiveService, "function",
      `VM final archive service is unavailable: ${module.loadError?.code ?? "missing export"}`);
    return module.createVmFinalArchiveService({ database, resolveArchivePlan: async () => plan(), ...options });
  };
  return { root, database, sourcePath, destinationDirectory, plan, load };
}

test("final archive publishes only a SHA-verified copy and persists event replay", async (t) => {
  const f = await fixture(t);
  const service = await f.load();
  const accepted = await service.enqueue(event);
  assert.equal(accepted.state, "pending");
  assert.equal((await service.processNext()).state, "published");
  assert.deepEqual(await readFile(path.join(f.destinationDirectory, "课程.mp4")), Buffer.from("verified mp4 bytes"));
  assert.equal((await service.enqueue(event)).state, "published");
  assert.equal(await service.processNext(), null);
});

test("final archive refuses a same-name different-SHA destination without overwriting it", async (t) => {
  const f = await fixture(t);
  const first = await f.load();
  await first.enqueue(event);
  assert.equal((await first.processNext()).state, "published");

  const differentSource = path.join(f.root, "different.mp4");
  const differentBytes = Buffer.from("different reviewed video");
  await writeFile(differentSource, differentBytes);
  const second = await f.load({ resolveArchivePlan: async () => f.plan({
    source: { deliveryId: "delivery_2", runId: "run_2", artifactId: "artifact_2",
      localPath: differentSource, sha256: digest(differentBytes), bytes: differentBytes.length },
  }) });
  const secondEvent = { ...event, eventId: "evt_archive_2" };
  await second.enqueue(secondEvent);
  const conflict = await second.processNext();
  assert.equal(conflict.state, "conflict");
  assert.equal(conflict.errorCode, "VM_ARCHIVE_DESTINATION_CONFLICT");
  assert.deepEqual(await readFile(path.join(f.destinationDirectory, "课程.mp4")), Buffer.from("verified mp4 bytes"));
});

test("final archive resumes a durable pending job after service reconstruction", async (t) => {
  const f = await fixture(t);
  const first = await f.load();
  await first.enqueue(event);
  const restarted = await f.load();
  assert.equal((await restarted.get(event.eventId)).state, "pending");
  assert.equal((await restarted.processNext()).state, "published");
  assert.equal((await stat(path.join(f.destinationDirectory, "课程.mp4"))).size, Buffer.byteLength("verified mp4 bytes"));
});

test("final archive recovery cleans its published hard link after a crash before temp unlink", async (t) => {
  const f = await fixture(t);
  let timestamp = 1_700_000_000_000;
  const first = await f.load({ now: () => timestamp });
  const job = await first.enqueue(event);
  const tempPath = path.join(f.destinationDirectory, `.${job.id}.${job.filename}.tmp`);
  await writeFile(tempPath, await readFile(f.sourcePath));
  await link(tempPath, path.join(f.destinationDirectory, job.filename));
  assert.equal((await stat(tempPath)).nlink, 2);

  const restarted = await f.load({ now: () => timestamp });
  assert.equal((await restarted.processNext()).state, "published");
  assert.deepEqual(await readFile(path.join(f.destinationDirectory, job.filename)), Buffer.from("verified mp4 bytes"));
  await assert.rejects(stat(tempPath), { code: "ENOENT" });
});

test("final archive blocks a source whose SHA changes after its plan is frozen", async (t) => {
  const f = await fixture(t);
  const service = await f.load();
  await service.enqueue(event);
  await writeFile(f.sourcePath, Buffer.from("tampered source bytes"));
  const result = await service.processNext();
  assert.equal(result.state, "conflict");
  assert.equal(result.errorCode, "VM_ARCHIVE_SOURCE_CHANGED");
  await assert.rejects(stat(path.join(f.destinationDirectory, "课程.mp4")), { code: "ENOENT" });
});

test("final archive requests reject caller-supplied local paths and malformed status edges", async (t) => {
  const f = await fixture(t);
  const service = await f.load();
  await assert.rejects(service.enqueue({...event,workspacePath: f.sourcePath}), {code: "VM_ARCHIVE_REQUEST_INVALID"});
  await assert.rejects(service.enqueue({...event,statusEdge: {...event.statusEdge,afterOptionIds: []}}),
    {code: "VM_ARCHIVE_REQUEST_INVALID"});
  assert.equal(await service.get(event.eventId),null);
});

test("final archive never switches its frozen source and rejects a superseded round before publication", async (t) => {
  const f = await fixture(t);
  let superseded = false, validations = 0;
  const service = await f.load({validateArchiveSource: async ({plan}) => {
    validations++;
    assert.equal(plan.source.runId, "run_1");
    if (superseded) {const error = new Error("superseded");error.code = "VM_ARCHIVE_SOURCE_SUPERSEDED";throw error;}
  }});
  await service.enqueue(event);superseded = true;
  const result = await service.processNext();
  assert.equal(result.state, "conflict");
  assert.equal(result.errorCode, "VM_ARCHIVE_SOURCE_SUPERSEDED");
  assert.ok(validations > 0);
  await assert.rejects(stat(path.join(f.destinationDirectory, "课程.mp4")), {code: "ENOENT"});
});

test("final archive rechecks frozen lineage after copying before publishing", async (t) => {
  const f = await fixture(t);
  let superseded = false;
  const {copyFile} = await import("node:fs/promises");
  const service = await f.load({copy: async (...args) => {await copyFile(...args);superseded = true;},
    validateArchiveSource: async () => {
      if (superseded) {const error = new Error("superseded");error.code = "VM_ARCHIVE_SOURCE_SUPERSEDED";throw error;}
    }});
  await service.enqueue(event);
  assert.equal((await service.processNext()).errorCode, "VM_ARCHIVE_SOURCE_SUPERSEDED");
  await assert.rejects(stat(path.join(f.destinationDirectory, "课程.mp4")), {code: "ENOENT"});
});

test("final archive retries its frozen source after restart without resolving a newer plan", async (t) => {
  const f = await fixture(t);
  let timestamp = 1_700_000_000_000;
  const first = await f.load({now:() => timestamp,copy: async () => {
    const error = new Error("busy");error.code = "EBUSY";throw error;
  }});
  await first.enqueue(event);
  const retry = await first.processNext();
  assert.equal(retry.state,"retry_wait");assert.equal(retry.attemptCount,1);
  timestamp = retry.nextAttemptAt;
  const restarted = await f.load({now:() => timestamp,resolveArchivePlan:async () => {
    assert.fail("a retry must retain its approved source and destination");
  }});
  assert.equal((await restarted.processNext()).state,"published");
  assert.deepEqual(await readFile(path.join(f.destinationDirectory,"课程.mp4")),await readFile(f.sourcePath));
});

test("final archive treats a same-SHA destination as idempotent and bounds transient retries", async (t) => {
  const f = await fixture(t);
  const service = await f.load();await service.enqueue(event);await service.processNext();
  await service.enqueue({...event,eventId:"evt_archive_same_sha"});
  assert.equal((await service.processNext()).state,"published");
  let timestamp = 1_700_000_000_000;
  const unavailable = await f.load({now:() => timestamp,resolveArchivePlan:async () => f.plan({
    filename:"other.mp4",destinationPath:path.join(f.destinationDirectory,"other.mp4"),
    canonicalLocationKey:path.join(f.destinationDirectory,"other.mp4").toLowerCase()}),
    copy:async () => {const error = new Error("busy");error.code="EBUSY";throw error;}});
  await unavailable.enqueue({...event,eventId:"evt_archive_retry_budget"});
  for (let count=1;count<=8;count++) {
    const result = await unavailable.processNext();
    assert.equal(result.attemptCount,count);
    assert.equal(result.state,count===8 ? "dead_letter" : "retry_wait");timestamp=result.nextAttemptAt;
  }
  assert.equal(await unavailable.processNext(),null);
});
