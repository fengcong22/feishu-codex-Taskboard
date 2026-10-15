import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { createVmApprovalStore } from "../server/vm-approval-store.mjs";
import { createVmDownloadMetadata } from "../server/vm-download-notifier.mjs";
import { createVmDownloadService } from "../server/vm-download-service.mjs";
import { createVmTaskDownloadAdapter } from "../server/vm-task-download-adapter.mjs";

const VMID = "678465c3d94605d24bb9361a";

test("the task adapter uses the active download service for exact lookup and enqueue", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vm-task-adapter-"));
  const database = new DatabaseSync(path.join(directory, "metadata.sqlite"));
  const store = createVmApprovalStore({ file: path.join(directory, "approval.sqlite"), now: () => 1_000_000 });
  const session = {
    client: () => null, identity: () => null,
    snapshot: () => ({ status: "disconnected", account: null, expiresAt: null, expirySource: "unknown",
      lastCheckedAt: null, errorCode: null, automaticRefreshSupported: false, crossDeviceAuthorizationSupported: false }),
    close: async () => {},
  };
  const service = createVmDownloadService({ store, metadata: createVmDownloadMetadata({ database }),
    session, defaultOutputRoot: directory, notifier: { available: () => false } });
  t.after(async () => { await service.close(); database.close(); await rm(directory, { recursive: true, force: true }); });
  const adapter = createVmTaskDownloadAdapter(service);
  const request = adapter.requestFor({ vmid: VMID, department: "动画组", reason: "切片剪辑", outputRoot: directory });
  const fingerprint = createHash("sha256").update(JSON.stringify(request)).digest("hex");
  assert.equal(adapter.lookup({ requestFingerprint: fingerprint }), null);
  const enqueued = adapter.enqueue({ vmids: [VMID], department: "动画组", reason: "切片剪辑", outputRoot: directory }).jobs[0];
  assert.equal(store.list().length, 1);
  assert.deepEqual(adapter.lookup({ requestFingerprint: fingerprint, jobId: enqueued.id }),
    service.lookupExact({ requestFingerprint: fingerprint, jobId: enqueued.id }));
  assert.equal(adapter.lookup({ requestFingerprint: "a".repeat(64), jobId: enqueued.id }), null);
  await adapter.wake();
  assert.equal(store.list().length, 1);
});
