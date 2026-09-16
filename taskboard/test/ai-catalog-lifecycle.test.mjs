import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { once } from "node:events";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";

import { discoverAiCatalog } from "../server/ai-chat-catalog.mjs";

for (const scenario of ["success", "skills failure", "models failure", "SIGTERM ignored"]) {
  test(`catalog ${scenario} waits for skills child close`, { timeout: 15_000 }, async (t) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-catalog-close-"));
    const executable = path.join(directory, "fake-codex.mjs");
    await writeFile(executable, `#!/usr/bin/env node
import { createInterface } from "node:readline";
if (process.argv[2] === "debug") {
  ${scenario === "models failure" ? "process.exit(2);" : ""}
  process.stdout.write(JSON.stringify({ models: [] }));
} else {
  setInterval(() => {}, 1000);
  for await (const line of createInterface({ input: process.stdin })) {
    const message = JSON.parse(line);
    if (message.method === "initialize") {
      process.stdout.write(JSON.stringify({ id: message.id, result: {} }) + "\\n");
    } else if (message.method === "skills/list") {
      process.stdout.write(JSON.stringify({ id: message.id, ${scenario === "skills failure" ? 'error: { code: -1 }' : 'result: { data: [] }'} }) + "\\n");
    }
  }
}

`);
    await chmod(executable, 0o755);
    const originalSpawn = childProcess.spawn;
    let releaseKill;
    let childClosed;
    let closed = false;
    const terminationRequested = Promise.withResolvers();
    // Use a real process, but hold termination in the parent so the assertion
    // tests event ordering on Windows too, where SIGTERM cannot be trapped.
    const spawnMock = t.mock.method(childProcess, "spawn", (...args) => {
      const child = originalSpawn(...args);
      const kill = child.kill.bind(child);
      releaseKill = () => kill("SIGKILL");
      childClosed = once(child, "close").then(() => { closed = true; });
      child.kill = (signal) => {
        if (scenario === "SIGTERM ignored" && signal === "SIGKILL") return kill(signal);
        terminationRequested.resolve();
        return true;
      };
      return child;
    });
    syncBuiltinESMExports();
    let settled = false;
    const discovery = discoverAiCatalog({ codexExecutable: executable, workspacePath: directory, processEnv: process.env })
      .then((value) => { settled = true; return { value }; }, (error) => { settled = true; return { error }; });
    try {
      await terminationRequested.promise;
      await setImmediate();
      assert.equal(settled, false, "catalog must retain its workspace until the child closes");
      if (scenario !== "SIGTERM ignored") releaseKill();
      const result = await discovery;
      assert.equal(closed, true);
      if (scenario === "skills failure") assert.match(result.error?.message ?? "", /could not list skills/);
      else if (scenario === "models failure") assert.equal(result.error?.code, 2);
      else assert.deepEqual(result.value.skills, []);
    } finally {
      releaseKill?.();
      await childClosed;
      await discovery;
      spawnMock.mock.restore();
      syncBuiltinESMExports();
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test("catalog skills failure waits for the model probe to release its workspace", { timeout: 15_000 }, async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-catalog-model-close-"));
  const executable = path.join(directory, "fake-codex.mjs");
  const releaseFile = path.join(directory, "release");
  await writeFile(executable, `#!/usr/bin/env node
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { setTimeout } from "node:timers/promises";
if (process.argv[2] === "debug") {
  while (!existsSync(${JSON.stringify(releaseFile)})) await setTimeout(10);
  process.stdout.write(JSON.stringify({ models: [] }));
} else {
  for await (const line of createInterface({ input: process.stdin })) {
    const message = JSON.parse(line);
    if (message.method === "initialize") {
      process.stdout.write(JSON.stringify({ id: message.id, error: { code: -1 } }) + "\\n");
    }
  }
}
`);
  await chmod(executable, 0o755);
  const originalSpawn = childProcess.spawn;
  let childClosed;
  const spawned = Promise.withResolvers();
  // This test only observes the real skills process, without changing kill.
  const spawnMock = t.mock.method(childProcess, "spawn", (...args) => {
    const child = originalSpawn(...args);
    childClosed = once(child, "close");
    spawned.resolve();
    return child;
  });
  syncBuiltinESMExports();
  let settled = false;
  const discovery = discoverAiCatalog({ codexExecutable: executable, workspacePath: directory, processEnv: process.env })
    .then((value) => { settled = true; return { value }; }, (error) => { settled = true; return { error }; });
  try {
    await spawned.promise;
    await childClosed;
    await setImmediate();
    assert.equal(settled, false, "a failed skills probe must still wait for the model process");
    await writeFile(releaseFile, "ready");
    assert.match((await discovery).error?.message ?? "", /rejected initialization/);
  } finally {
    await writeFile(releaseFile, "ready");
    await discovery;
    spawnMock.mock.restore();
    syncBuiltinESMExports();
    await rm(directory, { recursive: true, force: true });
  }
});

test("catalog terminates an unresponsive model probe at its deadline", { timeout: 15_000 }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-catalog-model-timeout-"));
  const executable = path.join(directory, "fake-codex.mjs");
  await writeFile(executable, `#!/usr/bin/env node
import { createInterface } from "node:readline";
if (process.argv[2] === "debug") {
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1000);
} else {
  for await (const line of createInterface({ input: process.stdin })) {
    const message = JSON.parse(line);
    if (message.id) process.stdout.write(JSON.stringify({ id: message.id, result: { data: [] } }) + "\\n");
  }
}
`);
  await chmod(executable, 0o755);
  try {
    await assert.rejects(
      discoverAiCatalog({ codexExecutable: executable, workspacePath: directory, processEnv: process.env }),
      (error) => error.killed === true && error.signal === "SIGKILL",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

for (const scenario of ["missing executable", "early exit"]) {
  test(`catalog rejects ${scenario} without leaving child handles open`, async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-catalog-start-"));
    const executable = path.join(directory, scenario === "early exit" ? "fake-codex.mjs" : "missing.exe");
    if (scenario === "early exit") {
      await writeFile(executable, '#!/usr/bin/env node\nif (process.argv[2] === "debug") process.stdout.write("{\\"models\\":[]}");\n');
      await chmod(executable, 0o755);
    }
    try {
      await assert.rejects(
        discoverAiCatalog({ codexExecutable: executable, workspacePath: directory, processEnv: process.env }),
        scenario === "early exit" ? /exited before listing skills/ : { code: "ENOENT" },
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}
