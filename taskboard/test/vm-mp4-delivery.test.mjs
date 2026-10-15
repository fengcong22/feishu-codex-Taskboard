import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { createVmMp4DeliveryService } from "../server/vm-mp4-delivery.mjs";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function fixture(t, overrides = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vm-mp4-delivery-"));
  const filename = path.join(directory, "result.mp4");
  const bytes = Buffer.from("validated-mp4-fixture");
  await writeFile(filename, bytes);
  const database = new DatabaseSync(path.join(directory, "delivery.sqlite"));
  const target = { baseToken: "base-1", tableId: "table-1", recordId: "record-1", fieldId: "field-output" };
  const trusted = {
    runId: "run-1", taskId: "task-1", artifactId: "artifact-1", productionOrigin: true,
    artifact: { kind: "review_mp4", validationStatus: "verified", path: filename,
      filename: "lesson_初稿.mp4", sha256: sha256(bytes), bytes: bytes.length }, target,
  };
  let resolved = overrides.trusted ?? trusted;
  let current = [];
  const calls = { upload: 0, update: 0 };
  const adapter = {
    async listFields() { return [{ field_id: "field-output", field_name: "视频成片审核", type: 17, ui_type: "Attachment" }]; },
    async getRecord() { return { fields: { "视频成片审核": current.map((entry) => ({ ...entry })) } }; },
    async updateRecord({ attachments }) { calls.update++; current = attachments.map((entry) => ({ ...entry })); },
    async uploadMedia({ filePath, filename: uploadName, sha256: expectedSha }) {
      calls.upload++;
      assert.equal(filePath, filename);
      assert.equal(uploadName, "lesson_初稿.mp4");
      assert.equal(expectedSha, sha256(bytes));
      return { file_token: "new-token" };
    },
    ...overrides.adapter,
  };
  let now = 1_700_000_000_000;
  const service = createVmMp4DeliveryService({ database, adapter,
    resolveTrustedDelivery: async () => resolved, now: () => now });
  t.after(async () => { database.close(); await rm(directory, { recursive: true, force: true }); });
  return { service, database, adapter, trusted, target, filename, bytes, calls,
    current: () => current, setCurrent: (value) => { current = value; },
    setTrusted: (value) => { resolved = value; },
    advance: (ms) => { now += ms; } };
}

test("a verified production MP4 is attached to an empty field and only readback completes delivery", async (t) => {
  const f = await fixture(t);
  const job = await f.service.enqueue({ runId: "run-1", artifactId: "artifact-1" });
  assert.equal(job.state, "upload_pending");
  assert.equal((await f.service.processNext()).state, "delivered");
  assert.deepEqual(f.current().map((entry) => entry.file_token), ["new-token"]);
  assert.equal(f.calls.upload, 1);
  assert.equal(f.calls.update, 1);
  assert.equal((await f.service.enqueue({ runId: "run-1", artifactId: "artifact-1" })).state, "delivered");
  assert.equal(await f.service.processNext(), null);
  assert.equal(f.calls.upload, 1);
});

test("an upload reservation loses eligibility when its production source is revoked", async (t) => {
  const f = await fixture(t);
  await f.service.enqueue({ runId: "run-1", artifactId: "artifact-1" });
  f.setTrusted({ ...f.trusted, productionOrigin: false });
  const result = await f.service.processNext();
  assert.equal(result.state, "conflict");
  assert.equal(result.errorCode, "VM_DELIVERY_UNTRUSTED");
  assert.equal(f.calls.upload, 0);
  assert.equal(f.calls.update, 0);
});

test("changed frozen delivery identity blocks an already persisted upload", async (t) => {
  const f = await fixture(t);
  await f.service.enqueue({ runId: "run-1", artifactId: "artifact-1" });
  f.setTrusted({ ...f.trusted, target: { ...f.target, recordId: "other-record" } });
  const result = await f.service.processNext();
  assert.equal(result.state, "conflict");
  assert.equal(result.errorCode, "VM_DELIVERY_IDENTITY_CONFLICT");
  assert.equal(f.calls.upload, 0);
  assert.equal(f.calls.update, 0);
});

test("source revocation during metadata preflight blocks the following upload", async (t) => {
  const f = await fixture(t, { adapter: { async listFields() {
    f.setTrusted(null);
    return [{ field_id: "field-output", field_name: "视频成片审核", type: 17, ui_type: "Attachment" }];
  } } });
  await f.service.enqueue({ runId: "run-1", artifactId: "artifact-1" });
  const result = await f.service.processNext();
  assert.equal(result.state, "conflict");
  assert.equal(result.errorCode, "VM_DELIVERY_UNTRUSTED");
  assert.equal(f.calls.upload, 0);
  assert.equal(f.calls.update, 0);
});

test("source revocation during upload preserves its token and blocks attachment", async (t) => {
  const f = await fixture(t, { adapter: { async uploadMedia() {
    f.calls.upload++;
    f.setTrusted({ ...f.trusted, productionOrigin: false });
    return { file_token: "new-token" };
  } } });
  await f.service.enqueue({ runId: "run-1", artifactId: "artifact-1" });
  const result = await f.service.processNext();
  assert.equal(result.state, "conflict");
  assert.equal(result.errorCode, "VM_DELIVERY_UNTRUSTED");
  assert.equal(result.fileToken, "new-token");
  assert.equal(f.calls.upload, 1);
  assert.equal(f.calls.update, 0);
});

test("source revocation during the last attachment read prevents the record update", async (t) => {
  let reads = 0;
  const f = await fixture(t, { adapter: { async getRecord() {
    reads++;
    if (reads === 2) f.setTrusted(null);
    return { fields: { "视频成片审核": [] } };
  } } });
  await f.service.enqueue({ runId: "run-1", artifactId: "artifact-1" });
  const result = await f.service.processNext();
  assert.equal(result.state, "conflict");
  assert.equal(result.errorCode, "VM_DELIVERY_UNTRUSTED");
  assert.equal(f.calls.upload, 1);
  assert.equal(f.calls.update, 0);
});

test("a pending attachment cannot resume after trusted task evidence disappears", async (t) => {
  const f = await fixture(t, { adapter: { async updateRecord() {
    f.calls.update++;
    throw new Error("temporary attachment outage");
  } } });
  await f.service.enqueue({ runId: "run-1", artifactId: "artifact-1" });
  assert.equal((await f.service.processNext()).state, "binding_pending");
  f.advance(60_000);
  const resumed = createVmMp4DeliveryService({ database: f.database, adapter: f.adapter,
    resolveTrustedDelivery: async () => null, now: () => 1_700_000_060_000 });
  const result = await resumed.processNext();
  assert.equal(result.state, "conflict");
  assert.equal(result.errorCode, "VM_DELIVERY_UNTRUSTED");
  assert.equal(result.fileToken, "new-token");
  assert.equal(f.calls.upload, 1);
  assert.equal(f.calls.update, 1);
});

test("an attachment worker loses permission to update after recovery during its final read", async (t) => {
  let reads = 0, recovered;
  const f = await fixture(t, { adapter: { async getRecord() {
    reads++;
    if (reads === 2) {
      f.advance(31 * 60 * 1000);
      recovered = createVmMp4DeliveryService({ database: f.database, adapter: f.adapter,
        resolveTrustedDelivery: async () => f.trusted,
        now: () => 1_700_000_000_000 + 31 * 60 * 1000 });
    }
    return { fields: { "视频成片审核": [] } };
  } } });
  await f.service.enqueue({ runId: "run-1", artifactId: "artifact-1" });
  const result = await f.service.processNext();
  assert.equal(result.state, "binding_pending");
  assert.equal(result.errorCode, null);
  assert.equal(result.fileToken, "new-token");
  assert.equal(recovered.get("run-1").state, "binding_pending");
  assert.equal(f.calls.upload, 1);
  assert.equal(f.calls.update, 0);
});

test("an expired upload owner cannot publish a token even before another worker recovers it", async (t) => {
  const f = await fixture(t, { adapter: { async uploadMedia() {
    f.calls.upload++;
    f.advance(31 * 60 * 1000);
    return { file_token: "late-token" };
  } } });
  await f.service.enqueue({ runId: "run-1", artifactId: "artifact-1" });
  const result = await f.service.processNext();
  assert.equal(result.state, "uploading");
  assert.equal(result.fileToken, null);
  assert.equal(f.calls.update, 0);
  f.service.recover();
  assert.equal(f.service.get("run-1").state, "upload_uncertain");
});

test("enqueue rejects an untrusted or altered artifact before persisting delivery", async (t) => {
  const f = await fixture(t);
  const wrong = { ...f.trusted, productionOrigin: false };
  f.setTrusted(wrong);
  await assert.rejects(f.service.enqueue({ runId: "run-1", artifactId: "artifact-1" }), { code: "VM_DELIVERY_UNTRUSTED" });
  f.setTrusted(f.trusted);
  await writeFile(f.filename, "tampered");
  await assert.rejects(f.service.enqueue({ runId: "run-1", artifactId: "artifact-1" }), { code: "VM_DELIVERY_ARTIFACT_CHANGED" });
  assert.equal(f.service.get("run-1"), null);
});

test("a lost bind response resumes by finding the persisted token without reuploading or appending twice", async (t) => {
  let first = true;
  const f = await fixture(t, { adapter: {
    async updateRecord({ attachments }) {
      f.calls.update++;
      f.setCurrent(attachments);
      if (first) { first = false; throw new Error("response lost"); }
    },
  } });
  await f.service.enqueue({ runId: "run-1", artifactId: "artifact-1" });
  assert.equal((await f.service.processNext()).state, "binding_pending");
  assert.equal(f.service.get("run-1").fileToken, "new-token");
  f.advance(60_000);
  assert.equal((await f.service.processNext()).state, "delivered");
  assert.equal(f.calls.upload, 1);
  assert.equal(f.calls.update, 1);
  assert.deepEqual(f.current().map((entry) => entry.file_token), ["new-token"]);
});

test("an uncertain upload cannot be blindly retried after a lost response or restart", async (t) => {
  const f = await fixture(t, { adapter: { async uploadMedia() { f.calls.upload++; throw new Error("response lost"); } } });
  await f.service.enqueue({ runId: "run-1", artifactId: "artifact-1" });
  assert.equal((await f.service.processNext()).state, "upload_uncertain");
  assert.equal(await f.service.processNext(), null);
  assert.equal(f.calls.upload, 1);
  f.database.prepare("UPDATE vm_mp4_deliveries SET state = 'uploading' WHERE run_id = ?").run("run-1");
  const restarted = createVmMp4DeliveryService({ database: f.database, adapter: f.adapter,
    resolveTrustedDelivery: async () => f.trusted });
  assert.equal(restarted.get("run-1").state, "upload_uncertain");
  assert.equal(await restarted.processNext(), null);
  assert.equal(f.calls.upload, 1);
});

test("a stale upload owner cannot commit after another instance recovers its expired lease", async (t) => {
  let enter, release;
  const entered = new Promise((resolve) => { enter = resolve; });
  const blocked = new Promise((resolve) => { release = resolve; });
  const f = await fixture(t, { adapter: { async uploadMedia() {
    f.calls.upload++; enter(); await blocked; return { file_token: "late-token" };
  } } });
  await f.service.enqueue({ runId: "run-1", artifactId: "artifact-1" });
  const first = f.service.processNext();
  await entered;
  f.advance(31 * 60 * 1000);
  const recovered = createVmMp4DeliveryService({ database: f.database, adapter: f.adapter,
    resolveTrustedDelivery: async () => f.trusted,
    now: () => 1_700_000_000_000 + 31 * 60 * 1000 });
  assert.equal(recovered.get("run-1").state, "upload_uncertain");
  release();
  await first;
  assert.equal(recovered.get("run-1").state, "upload_uncertain");
  assert.equal(recovered.get("run-1").fileToken, null);
  assert.equal(f.calls.update, 0);
});

test("a persisted token resumes attachment after service reconstruction without reupload", async (t) => {
  const f = await fixture(t, { adapter: { async updateRecord({ attachments }) {
    f.calls.update++;
    f.setCurrent(attachments);
    throw new Error("response lost");
  } } });
  await f.service.enqueue({ runId: "run-1", artifactId: "artifact-1" });
  assert.equal((await f.service.processNext()).state, "binding_pending");
  f.advance(60_000);
  const resumed = createVmMp4DeliveryService({ database: f.database, adapter: f.adapter,
    resolveTrustedDelivery: async () => f.trusted,
    now: () => 1_700_000_060_000 });
  assert.equal((await resumed.processNext()).state, "delivered");
  assert.equal(f.calls.upload, 1);
  assert.equal(f.calls.update, 1);
});

test("field drift or failed readback never declares an MP4 delivered", async (t) => {
  const field = await fixture(t, { adapter: { async listFields() { return [{ field_id: "field-output", field_name: "视频成片审核", type: 1, ui_type: "Text" }]; } } });
  await field.service.enqueue({ runId: "run-1", artifactId: "artifact-1" });
  assert.equal((await field.service.processNext()).state, "conflict");
  assert.equal(field.calls.upload, 0);
  const readback = await fixture(t, { adapter: {
    async updateRecord() { readback.calls.update++; },
  } });
  await readback.service.enqueue({ runId: "run-1", artifactId: "artifact-1" });
  assert.equal((await readback.service.processNext()).state, "conflict");
  assert.equal(readback.calls.upload, 1);
  assert.equal(readback.calls.update, 1);
});

test("an existing human attachment blocks binding instead of being rewritten", async (t) => {
  const f = await fixture(t);
  f.setCurrent([{ file_token: "human-token", name: "human.mp4" }]);
  await f.service.enqueue({ runId: "run-1", artifactId: "artifact-1" });
  assert.equal((await f.service.processNext()).state, "conflict");
  assert.deepEqual(f.current().map((entry) => entry.file_token), ["human-token"]);
  assert.equal(f.calls.update, 0);
});

test("an attachment appearing between two pre-bind reads blocks the update", async (t) => {
  let reads = 0;
  const f = await fixture(t, { adapter: { async getRecord() {
    reads++;
    if (reads === 2) f.setCurrent([{ file_token: "human-token" }]);
    return { fields: { "视频成片审核": f.current().map((entry) => ({ ...entry })) } };
  } } });
  await f.service.enqueue({ runId: "run-1", artifactId: "artifact-1" });
  assert.equal((await f.service.processNext()).state, "conflict");
  assert.equal(f.calls.update, 0);
  assert.deepEqual(f.current().map((entry) => entry.file_token), ["human-token"]);
});

test("repeated metadata outages exhaust a finite pre-upload retry budget", async (t) => {
  const f = await fixture(t, { adapter: { async listFields() { throw new Error("offline"); } } });
  await f.service.enqueue({ runId: "run-1", artifactId: "artifact-1" });
  for (let attempt = 0; attempt < 8; attempt++) {
    const result = await f.service.processNext();
    assert.equal(result.state, attempt === 7 ? "dead_letter" : "upload_pending");
    f.advance(10 * 60 * 1000);
  }
  assert.equal(f.service.get("run-1").attemptCount, 8);
  assert.equal(await f.service.processNext(), null);
  assert.equal(f.calls.upload, 0);
});
