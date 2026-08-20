import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const launcher = fileURLToPath(new URL("../scripts/detached-launcher.mjs", import.meta.url));

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForProcessExit(pid) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline && processExists(pid)) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function removeEventually(directory) {
  const deadline = Date.now() + 5_000;
  while (true) {
    try {
      await rm(directory, { recursive: true, force: true });
      return;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

test("detached launcher returns while its logged child remains alive", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codex-feishu-launcher-"));
  const childScript = path.join(directory, "child.mjs");
  const pidFile = path.join(directory, "child.pid");
  const stdoutFile = path.join(directory, "child.stdout.log");
  const stderrFile = path.join(directory, "child.stderr.log");
  let pid = null;

  try {
    await writeFile(childScript, [
      "console.log(`ready:${process.env.LAUNCH_TEST_VALUE}`);",
      "console.error('diagnostic');",
      "setInterval(() => {}, 1000);",
    ].join("\n"));

    const result = spawnSync(process.execPath, [
      launcher,
      "--script", childScript,
      "--cwd", directory,
      "--pid-file", pidFile,
      "--stdout", stdoutFile,
      "--stderr", stderrFile,
      "--env", "LAUNCH_TEST_VALUE=inherited",
    ], {
      encoding: "utf8",
      timeout: 5_000,
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    pid = Number(await readFile(pidFile, "utf8"));
    assert.equal(Number.isInteger(pid) && pid > 0, true);
    assert.equal(result.stdout.trim().split(/\r?\n/).length, 1);
    assert.equal(processExists(pid), true, `child ${pid} exited with its launcher`);

    const deadline = Date.now() + 2_000;
    let stdout = "";
    let stderr = "";
    while (Date.now() < deadline) {
      stdout = await readFile(stdoutFile, "utf8").catch(() => "");
      stderr = await readFile(stderrFile, "utf8").catch(() => "");
      if (stdout.includes("ready:inherited") && stderr.includes("diagnostic")) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.match(stdout, /ready:inherited/);
    assert.match(stderr, /diagnostic/);
  } finally {
    if (pid && processExists(pid)) {
      process.kill(pid, "SIGTERM");
      await waitForProcessExit(pid);
      if (processExists(pid)) process.kill(pid, "SIGKILL");
      await waitForProcessExit(pid);
    }
    await removeEventually(directory);
  }
});

test("detached launcher reports the child PID even when PID-file persistence fails", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codex-feishu-launcher-failure-"));
  const childScript = path.join(directory, "child.mjs");
  const invalidPidFile = path.join(directory, "missing", "child.pid");
  const stdoutFile = path.join(directory, "child.stdout.log");
  const stderrFile = path.join(directory, "child.stderr.log");
  let pid = null;

  try {
    await writeFile(childScript, "setTimeout(() => {}, 1000);\n");
    const result = spawnSync(process.execPath, [
      launcher,
      "--script", childScript,
      "--cwd", directory,
      "--pid-file", invalidPidFile,
      "--stdout", stdoutFile,
      "--stderr", stderrFile,
    ], {
      encoding: "utf8",
      timeout: 5_000,
    });

    assert.notEqual(result.status, 0);
    pid = Number(result.stdout.trim());
    assert.equal(Number.isInteger(pid) && pid > 0, true);
  } finally {
    if (pid && processExists(pid)) {
      process.kill(pid, "SIGTERM");
      await waitForProcessExit(pid);
      if (processExists(pid)) process.kill(pid, "SIGKILL");
      await waitForProcessExit(pid);
    }
    await removeEventually(directory);
  }
});
