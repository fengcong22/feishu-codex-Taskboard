import assert from "node:assert/strict";
import { link, mkdtemp, rename, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { withStateLock } from "../src/state-lock.mjs";

async function stateFilename() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "feishu-bridge-lock-"));
  return path.join(directory, "state.json");
}

function childOutput(child, timeoutMs = 2_000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error("child did not produce output before timeout"));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout.off("data", onData);
      child.off("error", onError);
      child.off("exit", onExit);
    };
    const finish = (error, output) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(output);
    };
    const onData = (output) => finish(null, output);
    const onError = (error) => finish(error);
    const onExit = (code, signal) => finish(
      new Error(`child exited before output (code=${code}, signal=${signal ?? "none"})`),
    );
    child.stdout.once("data", onData);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

function childExit(child, timeoutMs = 2_000) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error("child did not exit before timeout"));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      child.off("error", onError);
      child.off("exit", onExit);
    };
    const finish = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const onError = (error) => finish(error);
    const onExit = () => finish();
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

test("serializes concurrent critical sections for the same state file", async () => {
  const filename = await stateFilename();
  let active = 0;
  let maximum = 0;
  await Promise.all(Array.from({ length: 8 }, (_, index) => withStateLock(filename, async () => {
    active += 1;
    maximum = Math.max(maximum, active);
    await delay(index % 2 === 0 ? 10 : 5);
    active -= 1;
  })));
  assert.equal(maximum, 1);
});

test("serializes relative and absolute aliases of the same state path", async () => {
  const filename = await stateFilename();
  const relativeAlias = path.relative(process.cwd(), filename);
  let active = 0;
  let maximum = 0;
  await Promise.all([filename, relativeAlias].map((candidate) => withStateLock(candidate, async () => {
    active += 1;
    maximum = Math.max(maximum, active);
    await delay(10);
    active -= 1;
  })));
  assert.equal(maximum, 1);
});

test("keeps the same lock identity across atomic state-file replacements", async () => {
  const filename = await stateFilename();
  await writeFile(filename, "{}\n");
  let active = 0;
  let maximum = 0;
  await Promise.all(Array.from({ length: 4 }, (_, index) => withStateLock(filename, async () => {
    active += 1;
    maximum = Math.max(maximum, active);
    const temporary = `${filename}.${index}.tmp`;
    await writeFile(temporary, `${JSON.stringify({ index })}\n`);
    await rename(temporary, filename);
    await delay(5);
    active -= 1;
  })));
  assert.equal(maximum, 1);
});

test("releases the state lock when the critical section throws", async () => {
  const filename = await stateFilename();
  await assert.rejects(
    () => withStateLock(filename, async () => { throw new Error("expected failure"); }),
    /expected failure/,
  );
  assert.equal(await withStateLock(filename, async () => "reacquired"), "reacquired");
});

test("times out safely while another critical section owns the state lock", async () => {
  const filename = await stateFilename();
  let releaseOwner;
  let markAcquired;
  const acquired = new Promise((resolve) => { markAcquired = resolve; });
  const owner = withStateLock(filename, async () => {
    markAcquired();
    await new Promise((resolve) => { releaseOwner = resolve; });
  });
  await acquired;
  const startedAt = performance.now();
  await assert.rejects(
    () => withStateLock(filename, async () => {}, { timeoutMs: 40, retryMs: 1_000 }),
    (error) => error?.code === "STATE_LOCK_TIMEOUT",
  );
  assert.ok(performance.now() - startedAt < 500, "retry delay must not exceed the lock deadline");
  releaseOwner();
  await owner;
});

test("reacquires the state lock after its owner process exits", async (t) => {
  const filename = await stateFilename();
  const moduleUrl = new URL("../src/state-lock.mjs", import.meta.url).href;
  const source = `
    import { withStateLock } from ${JSON.stringify(moduleUrl)};
    await withStateLock(process.argv[1], async () => {
      process.stdout.write("acquired\\n");
      await new Promise(() => {});
    });
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", source, filename], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const output = await childOutput(child);
  assert.match(output.toString(), /acquired/);
  child.kill();
  await childExit(child);
  assert.equal(await withStateLock(filename, async () => "recovered"), "recovered");
});

test("a timed-out child releases failed IPC handles and exits", async (t) => {
  const filename = await stateFilename();
  let releaseOwner;
  let markAcquired;
  const acquired = new Promise((resolve) => { markAcquired = resolve; });
  const owner = withStateLock(filename, async () => {
    markAcquired();
    await new Promise((resolve) => { releaseOwner = resolve; });
  });
  await acquired;

  const moduleUrl = new URL("../src/state-lock.mjs", import.meta.url).href;
  const source = `
    import { withStateLock } from ${JSON.stringify(moduleUrl)};
    try {
      await withStateLock(process.argv[1], async () => {}, { timeoutMs: 100, retryMs: 1 });
    } catch (error) {
      process.stdout.write(error.code + "\\n");
    }
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", source, filename], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const output = await childOutput(child);
  assert.match(output.toString(), /STATE_LOCK_TIMEOUT/);
  await childExit(child, 1_000);

  releaseOwner();
  await owner;
});

test("rejects a state file symlink instead of replacing its target alias", async (t) => {
  const filename = await stateFilename();
  const alias = `${filename}.symlink`;
  await writeFile(filename, "{}\n");
  try {
    await symlink(filename, alias);
  } catch (error) {
    if (["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) {
      t.skip(`symlink creation is unavailable: ${error.code}`);
      return;
    }
    throw error;
  }
  await assert.rejects(
    () => withStateLock(alias, async () => {}),
    (error) => error?.code === "STATE_LOCK_TARGET_UNSUPPORTED",
  );
});

test("rejects hard-linked state file aliases instead of allowing split locks", async (t) => {
  const filename = await stateFilename();
  const alias = `${filename}.hardlink`;
  await writeFile(filename, "{}\n");
  try {
    await link(filename, alias);
  } catch (error) {
    if (["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) {
      t.skip(`hard-link creation is unavailable: ${error.code}`);
      return;
    }
    throw error;
  }
  await assert.rejects(
    () => withStateLock(alias, async () => {}),
    (error) => error?.code === "STATE_LOCK_TARGET_UNSUPPORTED",
  );
});
