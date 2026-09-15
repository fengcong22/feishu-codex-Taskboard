import { spawn } from "node:child_process";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { withoutTaskboardLauncherEnvironment } from "../shared/codex-environment.mjs";
import { signalProcessTree } from "../shared/process-tree.mjs";

const PROBE_PATH = fileURLToPath(new URL("./autocut-environment-probe.mjs", import.meta.url));
const ENVIRONMENT_ERRORS = {
  AUTOCUT_LARK_CLI_UNAVAILABLE: "Auto-Cut cannot access the configured Lark CLI; check the deployment and Taskboard account permissions",
  AUTOCUT_LARK_IDENTITY_UNAVAILABLE: "Auto-Cut cannot read a strict Lark user identity; check the Taskboard account's existing CLI authentication",
  AUTOCUT_READINESS_UNAVAILABLE: "Auto-Cut cannot read/write its readiness location; check AUTOCUT_LITE_READINESS_PATH and directory permissions",
  AUTOCUT_OUTPUT_UNAVAILABLE: "Auto-Cut cannot write to the bound job or ZIP directory",
  AUTOCUT_ENVIRONMENT_UNAVAILABLE: "Auto-Cut environment validation failed",
};

function timeoutSetting(value, fallback) {
  if (value === undefined || value === "") return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0 || number > 2_147_483_647) {
    throw runnerError("AUTOCUT_TIMEOUT_INVALID", "Auto-Cut timeouts must be positive integer milliseconds");
  }
  return number;
}

function runnerError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function collect(stream) {
  return new Promise((resolve) => {
    let value = "";
    stream?.setEncoding("utf8");
    stream?.on("data", (chunk) => {
      if (value.length < 64 * 1024) value += chunk;
    });
    stream?.on("end", () => resolve(value));
    stream?.on("close", () => resolve(value));
    if (!stream) resolve(value);
  });
}

function runtimeEnvironment(environment, run) {
  return {
    ...Object.fromEntries(Object.entries(withoutTaskboardLauncherEnvironment(environment)).filter(
      ([key]) => !key.toUpperCase().startsWith("CODEX_AUTOCUT_"),
    )),
    CODEX_AUTOCUT_SOURCE_MANIFEST_PATH: run.manifestPath,
    CODEX_AUTOCUT_SOURCE_MANIFEST_SHA256: run.manifestSha256,
    CODEX_AUTOCUT_EXECUTION_INPUT_PATH: run.executionInputPath,
    CODEX_AUTOCUT_JOB_ROOT: path.dirname(run.manifestPath),
    CODEX_AUTOCUT_DRAFTS_ROOT: run.draftsRoot,
    CODEX_AUTOCUT_RESULT_PATH: run.resultPath,
    CODEX_AUTOCUT_PACKAGE_ZIP_PATH: run.packageZipPath,
    CODEX_AUTOCUT_TASK_ID: run.taskId,
    CODEX_AUTOCUT_RUN_ID: run.runId,
    CODEX_AUTOCUT_SUBJECT_KEY: run.subjectKey,
    CODEX_AUTOCUT_CONFIG_VERSION: String(run.configVersion),
    CODEX_AUTOCUT_STAGE_ID: run.stageId,
    CODEX_AUTOCUT_EVENT_ID: run.eventId,
  };
}

async function resolveInstalledRuntime(workspacePath, environment) {
  if (typeof workspacePath !== "string" || !path.isAbsolute(workspacePath)) {
    throw runnerError("AUTOCUT_RUNTIME_UNAVAILABLE", "Auto-Cut package workspace is unavailable");
  }
  const localAppData = environment.LOCALAPPDATA;
  if (!localAppData || !path.isAbsolute(localAppData)) {
    throw runnerError("AUTOCUT_RUNTIME_UNAVAILABLE", "Auto-Cut local runtime is unavailable");
  }
  const reportPath = path.join(localAppData, "Auto-Cut", "auto-cut-lite", "deployment-report.json");
  let report;
  try {
    report = JSON.parse(await readFile(reportPath, "utf8"));
  } catch {
    throw runnerError("AUTOCUT_RUNTIME_UNAVAILABLE", "Auto-Cut deployment report is unavailable");
  }
  if (
    report?.deployment_status !== "installed"
    || path.resolve(report.workspace_root ?? "") !== path.resolve(workspacePath)
    || !path.isAbsolute(report.runtime_root ?? "")
    || !path.isAbsolute(report.components?.python?.runtime_path ?? "")
  ) {
    throw runnerError("AUTOCUT_RUNTIME_UNAVAILABLE", "Auto-Cut deployment does not match the registered package");
  }
  let runtimeRoot;
  let python;
  let script;
  let pythonInfo;
  let scriptInfo;
  try {
    runtimeRoot = await realpath(report.runtime_root);
    [python, script] = await Promise.all([
      realpath(report.components.python.runtime_path),
      realpath(path.join(runtimeRoot, "scripts", "jy_wrapper.py")),
    ]);
    [pythonInfo, scriptInfo] = await Promise.all([stat(python), stat(script)]);
  } catch {
    throw runnerError("AUTOCUT_RUNTIME_UNAVAILABLE", "Auto-Cut local runner is unavailable");
  }
  if (!pythonInfo.isFile() || !scriptInfo.isFile()) {
    throw runnerError("AUTOCUT_RUNTIME_UNAVAILABLE", "Auto-Cut local runner is unavailable");
  }
  const larkCli = report.components?.lark_cli?.path;
  if (typeof larkCli !== "string" || !path.isAbsolute(larkCli)) {
    throw runnerError("AUTOCUT_LARK_CLI_UNAVAILABLE", ENVIRONMENT_ERRORS.AUTOCUT_LARK_CLI_UNAVAILABLE);
  }
  const readinessPath = environment.AUTOCUT_LITE_READINESS_PATH
    || path.join(localAppData, "Auto-Cut", "auto-cut-lite", "runtime-readiness.json");
  return { runtimeRoot, python, script, larkCli, readinessPath };
}

async function runProcess(command, args, options, { signal, timeoutMs, timeoutCode, preflightTimeoutMs } = {}) {
  if (signal?.aborted) throw runnerError("AUTOCUT_RUN_INTERRUPTED", "Auto-Cut was interrupted");
  const child = spawn(command, args, {
    ...options,
    windowsHide: true,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  let failure;
  const terminate = (code, message) => {
    if (failure) return;
    failure = runnerError(code, message);
    signalProcessTree(child, "SIGTERM");
  };
  const abort = () => terminate("AUTOCUT_RUN_INTERRUPTED", "Auto-Cut was interrupted because Taskboard is shutting down");
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  const stdout = collect(child.stdout);
  const stderr = collect(child.stderr);
  const deadline = setTimeout(() => terminate(timeoutCode, "Auto-Cut exceeded its configured time limit"), timeoutMs);
  let preflightDeadline;
  if (preflightTimeoutMs) {
    preflightDeadline = setTimeout(() => terminate("AUTOCUT_PREFLIGHT_TIMEOUT", "Auto-Cut preflight stopped making progress; check CLI and readiness access"), preflightTimeoutMs);
    let buffer = "";
    // Auto-cut-lite emits progress JSON on stderr; stdout is its final result.
    child.stderr?.on("data", (chunk) => {
      buffer += chunk;
      if (buffer.length > 65_536) buffer = buffer.slice(-65_536);
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        try {
          const event = JSON.parse(line);
          if (event.type === "progress" && event.event === "phase"
            && event.phase === "preflight" && ["complete", "completed", "resumed"].includes(event.status)) {
            clearTimeout(preflightDeadline);
          }
        } catch {}
      }
    });
  }
  let exitCode;
  try {
    exitCode = await new Promise((resolve, reject) => {
      child.once("error", () => reject(runnerError("AUTOCUT_PROCESS_UNAVAILABLE", "Auto-Cut could not start the configured process")));
      child.once("close", (code) => resolve(code ?? 1));
    });
  } finally {
    signal?.removeEventListener("abort", abort);
    clearTimeout(deadline);
    clearTimeout(preflightDeadline);
  }
  if (failure) throw failure;
  return { exitCode, stdout: await stdout, stderr: await stderr };
}

export async function runLocalAutoCut({
  run, packageConfig, environment = process.env, signal,
  environmentTimeoutMs = environment.CODEX_TASKBOARD_AUTOCUT_ENVIRONMENT_TIMEOUT_MS,
  preflightTimeoutMs = environment.CODEX_TASKBOARD_AUTOCUT_PREFLIGHT_TIMEOUT_MS,
  runTimeoutMs = environment.CODEX_TASKBOARD_AUTOCUT_RUN_TIMEOUT_MS,
} = {}) {
  environmentTimeoutMs = timeoutSetting(environmentTimeoutMs, 30_000);
  preflightTimeoutMs = timeoutSetting(preflightTimeoutMs, 120_000);
  runTimeoutMs = timeoutSetting(runTimeoutMs, 2 * 60 * 60 * 1_000);
  const { runtimeRoot, python, script, larkCli, readinessPath } = await resolveInstalledRuntime(
    packageConfig.workspacePath,
    environment,
  );
  const runtimeEnv = runtimeEnvironment(environment, run);
  const pathKeys = Object.keys(runtimeEnv).filter((key) => key.toLowerCase() === "path");
  const existingPath = pathKeys.map((key) => runtimeEnv[key]).filter(Boolean).join(path.delimiter);
  for (const key of pathKeys) delete runtimeEnv[key];
  runtimeEnv.PATH = [path.dirname(larkCli), path.dirname(process.execPath), existingPath].filter(Boolean).join(path.delimiter);
  // Python 3.12+ on Windows must not prefer an executable in cwd over this PATH.
  if (process.platform === "win32") runtimeEnv.NoDefaultCurrentDirectoryInExePath = "1";
  runtimeEnv.AUTOCUT_LITE_READINESS_PATH = readinessPath;
  const probe = await runProcess(process.execPath, [PROBE_PATH, JSON.stringify({
    larkCli, readinessPath,
    directories: [path.dirname(run.manifestPath), run.draftsRoot, path.dirname(run.packageZipPath)],
  })], { cwd: runtimeRoot, env: runtimeEnv }, {
    signal, timeoutMs: environmentTimeoutMs, timeoutCode: "AUTOCUT_ENVIRONMENT_TIMEOUT",
  });
  let receipt;
  try { receipt = JSON.parse(probe.stdout); } catch {}
  if (probe.exitCode !== 0 || receipt?.ok !== true) {
    const code = Object.hasOwn(ENVIRONMENT_ERRORS, receipt?.code) ? receipt.code : "AUTOCUT_ENVIRONMENT_UNAVAILABLE";
    throw runnerError(code, ENVIRONMENT_ERRORS[code]);
  }
  const args = [
    script,
    "review-document-run",
    "--source-manifest", run.manifestPath,
    "--execution-input", run.executionInputPath,
    "--job-root", path.dirname(run.manifestPath),
    "--drafts-root", run.draftsRoot,
    "--package-zip", run.packageZipPath,
    "--result-path", run.resultPath,
    "--json",
  ];
  const result = await runProcess(python, args, {
    cwd: runtimeRoot,
    env: runtimeEnv,
  }, { signal, timeoutMs: runTimeoutMs, timeoutCode: "AUTOCUT_RUN_TIMEOUT", preflightTimeoutMs });
  if (signal?.aborted) {
    throw runnerError("AUTOCUT_RUN_INTERRUPTED", "Auto-Cut was interrupted because Taskboard is shutting down");
  }
  if (result.exitCode !== 0) {
    throw runnerError(
      "autocut_process_failed",
      "The Auto-Cut process did not complete successfully; inspect its bound result receipt",
    );
  }
  return result;
}
