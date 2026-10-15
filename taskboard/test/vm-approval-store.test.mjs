import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { link, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { createVmApprovalStore } from "../server/vm-approval-store.mjs";

function job(id = "job-1", overrides = {}) {
  return {
    id, request_fingerprint: "f".repeat(64), request: { vmid: "video-1", definition: "1080p" },
    status: "queued", attempts: 0, next_attempt_at: null, created_at: "2026-10-09T00:00:00.000Z",
    updated_at: "2026-10-09T00:00:00.000Z", ...overrides,
  };
}
function code(expected) { return (error) => error.code === expected && !error.message.includes("signed-secret"); }
async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vm-approval-store-"));
  const file = path.join(directory, "queue.sqlite");
  const stores = [];
  function open(options = {}) {
    const store = createVmApprovalStore({ file, ...options });
    stores.push(store);
    return store;
  }
  t.after(async () => {
    for (const store of stores) store.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, file, open };
}

test("persists progress across restart and duplicate enqueue does not reset it", async (t) => {
  const f = await fixture(t);
  const first = f.open();
  const input = job();
  assert.deepEqual(first.enqueue(input), input);
  input.status = "caller-mutation";
  const claimed = first.claim("job-1");
  const persisted = first.save("job-1", claimed.leaseToken, { ...claimed.job, status: "awaiting_approval", attempts: 1 });
  first.close();
  const reopened = f.open();
  assert.deepEqual(reopened.enqueue(job()), persisted);
  assert.deepEqual(reopened.enqueue(job("different-id")), persisted);
  assert.equal(reopened.get("different-id"), null);
  assert.deepEqual(reopened.get("job-1"), persisted);
  assert.deepEqual(reopened.list(), [persisted]);
  assert.equal(reopened.get("missing"), null);
  assert.equal(reopened.claim("missing"), null);
  assert.throws(() => reopened.enqueue(job("job-1", { request_fingerprint: "different" })), code("VM_APPROVAL_JOB_CONFLICT"));
  assert.throws(() => reopened.enqueue(job("job-1", { request: { vmid: "different-video" } })), code("VM_APPROVAL_JOB_CONFLICT"));
  assert.deepEqual(reopened.get("job-1"), persisted);
});

test("resource reservations are durable across owners, lease expiry and restarts", async (t) => {
  const f = await fixture(t);
  let time = 1000;
  const store = f.open({ now: () => time });
  const firstJob = store.enqueue(job());
  const secondJob = store.enqueue(job("job-2", { request_fingerprint: "b".repeat(64), request: { vmid: "video-2" } }));
  const first = store.claim(firstJob.id, { leaseMs: 100 });
  const second = store.claim(secondJob.id, { leaseMs: 100 });
  const fingerprint = "a".repeat(64);
  assert.throws(() => store.reserveResource(firstJob.id, "wrong-owner", fingerprint), code("VM_APPROVAL_LEASE_LOST"));
  assert.deepEqual(store.reserveResource(firstJob.id, first.leaseToken, fingerprint), { job_id: firstJob.id, owned: true });
  assert.deepEqual(store.reserveResource(firstJob.id, first.leaseToken, fingerprint), { job_id: firstJob.id, owned: true });
  assert.deepEqual(store.reserveResource(secondJob.id, second.leaseToken, fingerprint), { job_id: firstJob.id, owned: false });
  time = 1100;
  assert.throws(() => store.reserveResource(firstJob.id, first.leaseToken, "c".repeat(64)), code("VM_APPROVAL_LEASE_LOST"));
  store.close();
  const reopened = f.open({ now: () => time });
  const retry = reopened.claim(secondJob.id);
  assert.deepEqual(reopened.reserveResource(secondJob.id, retry.leaseToken, fingerprint), { job_id: firstJob.id, owned: false });
  assert.equal(reopened.reserveResource(secondJob.id, retry.leaseToken, "c".repeat(64)).owned, true);
});

test("competing database connections cannot reserve one resource for different jobs", async (t) => {
  const f = await fixture(t);
  const first = f.open();
  const second = f.open();
  first.enqueue(job());
  second.enqueue(job("job-2", { request_fingerprint: "b".repeat(64), request: { vmid: "video-2" } }));
  const lease1 = first.claim("job-1");
  const lease2 = second.claim("job-2");
  const fingerprint = "e".repeat(64);
  const owner = first.reserveResource("job-1", lease1.leaseToken, fingerprint);
  const denied = second.reserveResource("job-2", lease2.leaseToken, fingerprint);
  assert.deepEqual(owner, { job_id: "job-1", owned: true });
  assert.deepEqual(denied, { job_id: "job-1", owned: false });
});

test("only one owner claims a job and expired owners cannot save or renew", async (t) => {
  const f = await fixture(t);
  let time = 1000;
  const first = f.open({ now: () => time });
  const second = f.open({ now: () => time });
  first.enqueue(job());
  const lease = first.claim("job-1", { leaseMs: 100 });
  assert.equal(lease.expiresAt, 1100);
  assert.equal(second.claim("job-1"), null);
  first.save("job-1", lease.leaseToken, { ...lease.job, status: "submitting" }, { release: false });
  assert.equal(second.claim("job-1"), null);
  time = 1050;
  assert.deepEqual(first.renew("job-1", lease.leaseToken, { leaseMs: 100 }), { leaseToken: lease.leaseToken, expiresAt: 1150 });
  time = 1100;
  assert.equal(second.claim("job-1"), null);
  time = 1150;
  assert.throws(() => first.renew("job-1", lease.leaseToken), code("VM_APPROVAL_LEASE_LOST"));
  assert.throws(() => first.save("job-1", lease.leaseToken, lease.job), code("VM_APPROVAL_LEASE_LOST"));
  const next = second.claim("job-1");
  assert.notEqual(next.leaseToken, lease.leaseToken);
  assert.equal(next.job.status, "submitting");
  assert.throws(() => first.save("job-1", lease.leaseToken, lease.job), code("VM_APPROVAL_LEASE_LOST"));
  second.save("job-1", next.leaseToken, { ...next.job, status: "approved" });
  assert.ok(first.claim("job-1"));
});

test("two processes race for one durable lease and a crashed owner expires", { timeout: 20_000 }, async (t) => {
  const f = await fixture(t);
  const store = f.open({ now: () => 1000 });
  store.enqueue(job());
  const source = `
    import { createVmApprovalStore } from ${JSON.stringify(new URL("../server/vm-approval-store.mjs", import.meta.url).href)};
    const store = createVmApprovalStore({file: process.argv[1], now: () => 1000});
    process.send({ready: true});
    process.on('message', () => {
      const lease = store.claim('job-1', {leaseMs: 1000});
      process.send({claimed: Boolean(lease)});
    });
  `;
  async function worker() {
    const child = spawn(process.execPath, ["--input-type=module", "-e", source, f.file], {
      stdio: ["ignore", "ignore", "ignore", "ipc"], windowsHide: true,
    });
    t.after(() => { if (child.exitCode === null) child.kill(); });
    const [ready] = await once(child, "message");
    assert.equal(ready.ready, true);
    return child;
  }
  const children = await Promise.all([worker(), worker()]);
  const pending = children.map((child) => once(child, "message"));
  for (const child of children) child.send("claim");
  const results = await Promise.all(pending);
  assert.equal(results.filter(([result]) => result.claimed).length, 1);
  assert.equal(store.claim("job-1"), null);
  await Promise.all(children.map(async (child) => { const exited = once(child, "exit"); child.kill(); await exited; }));
  assert.equal(f.open({ now: () => 1999 }).claim("job-1"), null);
  assert.ok(f.open({ now: () => 2000 }).claim("job-1"));
});

test("rejects credentials and signed URLs but persists trusted origin configuration", async (t) => {
  const f = await fixture(t);
  const store = f.open();
  for (const privateValue of [
    { token: "signed-secret" }, { nested: { authorization: "signed-secret" } },
    { download_url: "https://files.example/video.mp4?token=signed-secret" },
    { value: "https://files.example/video.mp4?token=signed-secret" }, { reason: "Bearer signed-secret" },
    { origin: "https://files.example/video.mp4?token=signed-secret" },
  ]) {
    assert.throws(() => store.enqueue(job("private", privateValue)), code("VM_APPROVAL_STORE_PRIVATE_DATA"));
  }
  const input = job("trusted", { request: {
    allowed_origins: ["https://files.example"],
    private_endpoints: [{ origin: "https://internal.example:9443", addresses: ["10.1.2.3"] }],
  } });
  assert.deepEqual(store.enqueue(input), input);
  assert.equal(store.get("private"), null);
  assert.equal((await readFile(f.file)).includes(Buffer.from("signed-secret")), false);
});

test("foreign, empty and corrupt databases fail closed without being overwritten", async (t) => {
  const f = await fixture(t);
  await writeFile(f.file, "");
  assert.throws(() => f.open(), code("VM_APPROVAL_STORE_INVALID"));
  await writeFile(f.file, "corrupt fixture");
  assert.throws(() => f.open(), code("VM_APPROVAL_STORE_FAILED"));
  assert.equal(await readFile(f.file, "utf8"), "corrupt fixture");
  const foreignFile = path.join(f.directory, "taskboard.sqlite");
  const foreign = new DatabaseSync(foreignFile);
  foreign.exec("CREATE TABLE tasks (id TEXT PRIMARY KEY); INSERT INTO tasks VALUES ('production-fixture')");
  foreign.close();
  const before = await readFile(foreignFile);
  assert.throws(() => createVmApprovalStore({ file: foreignFile }), code("VM_APPROVAL_STORE_INVALID"));
  assert.deepEqual(await readFile(foreignFile), before);
});

test("rejects tampered persisted JSON instead of silently dropping the job", async (t) => {
  const f = await fixture(t);
  const store = f.open();
  store.enqueue(job());
  store.close();
  const raw = new DatabaseSync(f.file);
  raw.exec("UPDATE vm_approval_jobs SET job_json = '[]'");
  raw.close();
  assert.throws(() => f.open(), code("VM_APPROVAL_STORE_INVALID"));
});

test("cannot change immutable request fields or write with a forged lease", async (t) => {
  const f = await fixture(t);
  const store = f.open();
  store.enqueue(job());
  const lease = store.claim("job-1");
  assert.throws(() => store.save("job-1", lease.leaseToken, job("job-1", { request: { vmid: "video-2" } })), code("VM_APPROVAL_JOB_CONFLICT"));
  assert.throws(() => store.save("job-1", "forged", { ...lease.job, status: "approved" }), code("VM_APPROVAL_LEASE_LOST"));
  assert.throws(() => store.renew("job-1", "forged"), code("VM_APPROVAL_LEASE_LOST"));
  assert.equal(store.get("job-1").status, "queued");
  assert.ok(store.save("job-1", lease.leaseToken, lease.job));
});

test("rejects hard links both on opening and during every store operation", async (t) => {
  const f = await fixture(t);
  const store = f.open();
  store.enqueue(job());
  const alias = path.join(f.directory, "alias.sqlite");
  await link(f.file, alias);
  assert.throws(() => createVmApprovalStore({ file: alias }), code("VM_APPROVAL_STORE_PATH_INVALID"));
  assert.throws(() => store.get("job-1"), code("VM_APPROVAL_STORE_PATH_INVALID"));
  assert.throws(() => store.list(), code("VM_APPROVAL_STORE_PATH_INVALID"));
  assert.throws(() => store.claim("job-1"), code("VM_APPROVAL_STORE_PATH_INVALID"));
});

test("rejects a substituted database path even if it points at another valid queue", async (t) => {
  const f = await fixture(t);
  const store = f.open();
  store.enqueue(job());
  const otherFile = path.join(f.directory, "replacement.sqlite");
  const other = createVmApprovalStore({ file: otherFile });
  other.enqueue(job("replacement"));
  other.close();
  try { await rename(f.file, path.join(f.directory, "original.sqlite")); }
  catch (error) {
    if (["EPERM", "EBUSY", "EACCES"].includes(error.code)) { t.skip("OS prevents replacing an open SQLite file"); return; }
    throw error;
  }
  await rename(otherFile, f.file);
  assert.throws(() => store.list(), code("VM_APPROVAL_STORE_PATH_INVALID"));
});

test("rejects symlink database aliases", async (t) => {
  const f = await fixture(t);
  const store = f.open();
  store.close();
  const alias = path.join(f.directory, "alias.sqlite");
  try { await symlink(f.file, alias, "file"); }
  catch (error) {
    if (["EPERM", "EACCES"].includes(error.code)) { t.skip("file symlink privileges unavailable"); return; }
    throw error;
  }
  assert.throws(() => createVmApprovalStore({ file: alias }), code("VM_APPROVAL_STORE_PATH_INVALID"));
});

test("rejects directory symlink aliases including Windows junctions", async (t) => {
  const f = await fixture(t);
  const store = f.open();
  store.close();
  const directoryAlias = path.join(f.directory, "directory-alias");
  await symlink(f.directory, directoryAlias, process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => createVmApprovalStore({ file: path.join(directoryAlias, "queue.sqlite") }), code("VM_APPROVAL_STORE_PATH_INVALID"));
});
