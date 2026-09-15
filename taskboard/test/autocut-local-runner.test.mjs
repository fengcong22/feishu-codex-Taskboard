import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { runLocalAutoCut } from "../server/autocut-local-runner.mjs";

async function waitForJson(filename, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return JSON.parse(await readFile(filename, "utf8"));
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for '${filename}'`);
}

async function fixture(scriptBody) {
  const root = await mkdtemp(path.join(os.tmpdir(), "taskboard-autocut-runner-"));
  const localAppData = path.join(root, "localappdata");
  const workspacePath = path.join(root, "Auto-Cut Lite workspace");
  const runtimeRoot = path.join(root, "installed runtime");
  const script = path.join(runtimeRoot, "scripts", "jy_wrapper.py");
  await Promise.all([
    mkdir(path.dirname(script), { recursive: true }),
    mkdir(workspacePath, { recursive: true }),
    mkdir(path.join(localAppData, "Auto-Cut", "auto-cut-lite"), { recursive: true }),
  ]);
  await writeFile(script, scriptBody, "utf8");
  const larkDirectory = path.join(root, "user npm");
  const larkScript = path.join(larkDirectory, "node_modules", "@larksuite", "cli", "scripts", "run.js");
  await mkdir(path.dirname(larkScript), { recursive: true });
  await writeFile(path.join(larkDirectory, "lark-cli.cmd"), "fixture shim");
  await writeFile(larkScript, 'console.log(JSON.stringify({available:true,identity:"user",defaultAs:"user"}));');
  await writeFile(
    path.join(localAppData, "Auto-Cut", "auto-cut-lite", "deployment-report.json"),
    JSON.stringify({
      deployment_status: "installed",
      workspace_root: workspacePath,
      runtime_root: runtimeRoot,
      components: {
        python: { runtime_path: process.execPath },
        lark_cli: { path: path.join(larkDirectory, "lark-cli.cmd") },
      },
    }),
    "utf8",
  );
  const jobRoot = path.join(root, "job");
  const outputRoot = path.join(root, "output");
  await mkdir(path.join(jobRoot, "drafts"), { recursive: true });
  await mkdir(outputRoot);
  const run = {
    taskId: "task-fixed",
    runId: "run-fixed",
    subjectKey: "base:table",
    configVersion: 7,
    stageId: "initial",
    eventId: "event-fixed",
    manifestPath: path.join(jobRoot, "source manifest.json"),
    manifestSha256: "a".repeat(64),
    executionInputPath: path.join(jobRoot, "execution input.json"),
    draftsRoot: path.join(jobRoot, "drafts"),
    resultPath: path.join(jobRoot, "result.json"),
    packageZipPath: path.join(outputRoot, "course & exact.zip"),
  };
  return {
    root,
    localAppData,
    runtimeRoot,
    workspacePath,
    larkScript,
    run,
    packageConfig: { workspacePath },
  };
}

test("launches the installed Auto-Cut runtime with only the bound run paths", async () => {
  const capturePath = path.join(os.tmpdir(), `taskboard-runner-capture-${process.pid}-${Date.now()}.json`);
  const current = await fixture(`
const { writeFileSync } = require("node:fs");
const keys = Object.keys(process.env).filter((key) => (
  key.startsWith("CODEX_AUTOCUT_")
  || key === "FEISHU_APP_ID"
  || key === "FEISHU_APP_SECRET"
));
writeFileSync(process.env.RUNNER_CAPTURE_PATH, JSON.stringify({
  args: process.argv.slice(2),
  cwd: process.cwd(),
  env: Object.fromEntries(keys.map((key) => [key, process.env[key]])),
}));
process.stdout.write("fixture complete");
`);
  try {
    const result = await runLocalAutoCut({
      run: current.run,
      packageConfig: current.packageConfig,
      environment: {
        ...process.env,
        LOCALAPPDATA: current.localAppData,
        RUNNER_CAPTURE_PATH: capturePath,
        CODEX_AUTOCUT_UNTRUSTED: "must-not-reach-the-runtime",
        FEISHU_APP_ID: "must-not-reach-the-runtime",
        FEISHU_APP_SECRET: "must-not-reach-the-runtime",
      },
    });
    const capture = await waitForJson(capturePath);
    assert.equal(result.exitCode, 0);
    assert.deepEqual(capture.args, [
      "review-document-run",
      "--source-manifest", current.run.manifestPath,
      "--execution-input", current.run.executionInputPath,
      "--job-root", path.dirname(current.run.manifestPath),
      "--drafts-root", current.run.draftsRoot,
      "--package-zip", current.run.packageZipPath,
      "--result-path", current.run.resultPath,
      "--json",
    ]);
    assert.equal(await realpath(capture.cwd), await realpath(current.runtimeRoot));
    assert.deepEqual(capture.env, {
      CODEX_AUTOCUT_CONFIG_VERSION: "7",
      CODEX_AUTOCUT_DRAFTS_ROOT: current.run.draftsRoot,
      CODEX_AUTOCUT_EVENT_ID: current.run.eventId,
      CODEX_AUTOCUT_EXECUTION_INPUT_PATH: current.run.executionInputPath,
      CODEX_AUTOCUT_JOB_ROOT: path.dirname(current.run.manifestPath),
      CODEX_AUTOCUT_PACKAGE_ZIP_PATH: current.run.packageZipPath,
      CODEX_AUTOCUT_RESULT_PATH: current.run.resultPath,
      CODEX_AUTOCUT_RUN_ID: current.run.runId,
      CODEX_AUTOCUT_SOURCE_MANIFEST_PATH: current.run.manifestPath,
      CODEX_AUTOCUT_SOURCE_MANIFEST_SHA256: current.run.manifestSha256,
      CODEX_AUTOCUT_STAGE_ID: current.run.stageId,
      CODEX_AUTOCUT_SUBJECT_KEY: current.run.subjectKey,
      CODEX_AUTOCUT_TASK_ID: current.run.taskId,
    });
  } finally {
    await rm(capturePath, { force: true });
    await rm(current.root, { recursive: true, force: true });
  }
});

for (const scenario of ["missing-cli", "denied-auth", "invalid-readiness", "whoami-timeout"]) {
  test(`fails promptly before running Auto-Cut: ${scenario}`, async () => {
    const current = await fixture('require("node:fs").writeFileSync(process.env.UNEXPECTED_RUN, "started");');
    const capture = path.join(current.root, "unexpected-run");
    const environment = { ...process.env, LOCALAPPDATA: current.localAppData, UNEXPECTED_RUN: capture };
    let code;
    if (scenario === "missing-cli") {
      await rm(current.larkScript);
      code = "AUTOCUT_LARK_CLI_UNAVAILABLE";
    } else if (scenario === "denied-auth") {
      await writeFile(current.larkScript, 'console.error("Access denied credential=must-stay-private"); process.exit(1);');
      code = "AUTOCUT_LARK_IDENTITY_UNAVAILABLE";
    } else if (scenario === "invalid-readiness") {
      const parent = path.join(current.root, "not-a-directory");
      await writeFile(parent, "file");
      environment.AUTOCUT_LITE_READINESS_PATH = path.join(parent, "runtime-readiness.json");
      code = "AUTOCUT_READINESS_UNAVAILABLE";
    } else {
      await writeFile(current.larkScript, 'setInterval(() => {}, 1000);');
      code = "AUTOCUT_ENVIRONMENT_TIMEOUT";
    }
    try {
      await assert.rejects(runLocalAutoCut({
        run: current.run, packageConfig: current.packageConfig, environment,
        environmentTimeoutMs: scenario === "whoami-timeout" ? 800 : 5_000,
      }), (error) => error.code === code && !error.message.includes("must-stay-private"));
      await assert.rejects(readFile(capture), { code: "ENOENT" });
    } finally {
      await rm(current.root, { recursive: true, force: true });
    }
  });
}

test("uses the configured Lark entrypoint with no taskctl or lark-cli on PATH and preserves readiness", async () => {
  const current = await fixture('process.stdout.write("complete");');
  const readinessPath = path.join(current.localAppData, "Auto-Cut", "auto-cut-lite", "runtime-readiness.json");
  const readiness = '{"lark":{"status":"verified"},"asr":{"status":"verified"}}';
  await writeFile(readinessPath, readiness);
  try {
    const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== "path"));
    const result = await runLocalAutoCut({
      run: current.run, packageConfig: current.packageConfig,
      environment: { ...environment, PATH: "", LOCALAPPDATA: current.localAppData },
    });
    assert.equal(result.exitCode, 0);
    assert.equal(await readFile(readinessPath, "utf8"), readiness);
  } finally { await rm(current.root, { recursive: true, force: true }); }
});

test("bounds a runtime stuck in preflight and suppresses raw runtime errors", async () => {
  const current = await fixture('console.log(JSON.stringify({type:"progress",event:"phase",phase:"preflight",status:"started"})); setInterval(() => {}, 1000);');
  try {
    await assert.rejects(runLocalAutoCut({
      run: current.run, packageConfig: current.packageConfig,
      environment: { ...process.env, LOCALAPPDATA: current.localAppData },
      preflightTimeoutMs: 500,
    }), { code: "AUTOCUT_PREFLIGHT_TIMEOUT" });
  } finally { await rm(current.root, { recursive: true, force: true }); }
});

test("runtime failure does not expose arbitrary stdout or stderr", async () => {
  const current = await fixture('console.error("credential=must-stay-private"); process.exit(1);');
  try {
    await assert.rejects(runLocalAutoCut({
      run: current.run, packageConfig: current.packageConfig,
      environment: { ...process.env, LOCALAPPDATA: current.localAppData },
    }), (error) => error.code === "autocut_process_failed" && !error.message.includes("must-stay-private"));
  } finally { await rm(current.root, { recursive: true, force: true }); }
});

test("stops a stuck post-preflight run at its overall deadline", async () => {
  const current = await fixture('console.error(JSON.stringify({type:"progress",event:"phase",phase:"preflight",status:"complete"})); setInterval(() => {}, 1000);');
  try {
    await assert.rejects(runLocalAutoCut({
      run: current.run, packageConfig: current.packageConfig,
      environment: { ...process.env, LOCALAPPDATA: current.localAppData },
      preflightTimeoutMs: 2_000, runTimeoutMs: 3_000,
    }), { code: "AUTOCUT_RUN_TIMEOUT" });
  } finally { await rm(current.root, { recursive: true, force: true }); }
});

test("rejects a read-only readiness file before editing on Windows", { skip: process.platform !== "win32" }, async () => {
  const current = await fixture('require("node:fs").writeFileSync(process.env.UNEXPECTED_RUN, "started");');
  const readinessPath = path.join(current.localAppData, "Auto-Cut", "auto-cut-lite", "runtime-readiness.json");
  const capture = path.join(current.root, "unexpected-run");
  await writeFile(readinessPath, '{"status":"existing"}');
  await chmod(readinessPath, 0o444);
  try {
    await assert.rejects(runLocalAutoCut({
      run: current.run, packageConfig: current.packageConfig,
      environment: { ...process.env, LOCALAPPDATA: current.localAppData, UNEXPECTED_RUN: capture },
    }), { code: "AUTOCUT_READINESS_UNAVAILABLE" });
    await assert.rejects(readFile(capture), { code: "ENOENT" });
    assert.equal(await readFile(readinessPath, "utf8"), '{"status":"existing"}');
  } finally {
    await chmod(readinessPath, 0o666);
    await rm(current.root, { recursive: true, force: true });
  }
});

test("rejects non-user authentication and malformed whoami output without exposing it", async () => {
  const current = await fixture('throw new Error("runtime must not start");');
  try {
    for (const output of ['{ "available":true, "identity":"bot", "defaultAs":"bot" }', 'credential=must-stay-private']) {
      await writeFile(current.larkScript, `console.log(${JSON.stringify(output)});`);
      await assert.rejects(runLocalAutoCut({
        run: current.run, packageConfig: current.packageConfig,
        environment: { ...process.env, LOCALAPPDATA: current.localAppData },
      }), { code: "AUTOCUT_LARK_IDENTITY_UNAVAILABLE" });
    }
  } finally { await rm(current.root, { recursive: true, force: true }); }
});

for (const scenario of ["js-entrypoint", "native-exe-with-old-cmd", "different-adjacent-node"]) {
  test(`rejects Windows CLI resolution that could differ from the runtime: ${scenario}`, { skip: process.platform !== "win32" }, async () => {
    const current = await fixture('require("node:fs").writeFileSync(process.env.UNEXPECTED_RUN, "started");');
    const capture = path.join(current.root, "unexpected-run");
    try {
      if (scenario !== "different-adjacent-node") {
        const reportPath = path.join(current.localAppData, "Auto-Cut", "auto-cut-lite", "deployment-report.json");
        const report = JSON.parse(await readFile(reportPath, "utf8"));
        report.components.lark_cli.path = scenario === "js-entrypoint" ? current.larkScript : process.execPath;
        await writeFile(reportPath, JSON.stringify(report));
      } else {
        await writeFile(path.join(current.root, "user npm", "node.exe"), "different Node binary");
      }
      await assert.rejects(runLocalAutoCut({
        run: current.run, packageConfig: current.packageConfig,
        environment: {
          ...Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== "path")),
          LOCALAPPDATA: current.localAppData, UNEXPECTED_RUN: capture,
          PATH: path.join(current.root, "user npm"),
        },
      }), { code: "AUTOCUT_LARK_CLI_UNAVAILABLE" });
      await assert.rejects(readFile(capture), { code: "ENOENT" });
    } finally { await rm(current.root, { recursive: true, force: true }); }
  });
}

test("terminates the local Auto-Cut process when Taskboard shuts down", async () => {
  const readyPath = path.join(os.tmpdir(), `taskboard-runner-ready-${process.pid}-${Date.now()}.json`);
  const current = await fixture(`
const { writeFileSync } = require("node:fs");
writeFileSync(process.env.RUNNER_READY_PATH, "{}");
setInterval(() => {}, 1_000);
`);
  const controller = new AbortController();
  try {
    const pending = runLocalAutoCut({
      run: current.run,
      packageConfig: current.packageConfig,
      environment: {
        ...process.env,
        LOCALAPPDATA: current.localAppData,
        RUNNER_READY_PATH: readyPath,
      },
      signal: controller.signal,
    });
    await waitForJson(readyPath);
    controller.abort();
    await assert.rejects(
      pending,
      (error) => error?.code === "AUTOCUT_RUN_INTERRUPTED",
    );
  } finally {
    controller.abort();
    await rm(readyPath, { force: true });
    await rm(current.root, { recursive: true, force: true });
  }
});

test("reports an unavailable local runner when its installed script is missing", async () => {
  const current = await fixture("process.exit(0);");
  try {
    await rm(path.join(current.runtimeRoot, "scripts", "jy_wrapper.py"));
    await assert.rejects(
      runLocalAutoCut({
        run: current.run,
        packageConfig: current.packageConfig,
        environment: { ...process.env, LOCALAPPDATA: current.localAppData },
      }),
      (error) => error?.code === "AUTOCUT_RUNTIME_UNAVAILABLE"
        && error?.message === "Auto-Cut local runner is unavailable",
    );
  } finally {
    await rm(current.root, { recursive: true, force: true });
  }
});
