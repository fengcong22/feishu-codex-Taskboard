import { spawn } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

import { signalProcessTree } from "../shared/process-tree.mjs";
import { validateVmPmoInput, validateVmPmoPlan, validateVmPmoRender } from "./vm-pmo-result-validator.mjs";

function failure(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

async function regularFile(file) {
  const info = await lstat(file);
  return info.isFile() && !info.isSymbolicLink() && info.nlink === 1;
}

function processEnvironment(environment) {
  const allowed = new Set(["path", "systemroot", "windir", "temp", "tmp", "lang", "lc_all"]);
  const result = Object.fromEntries(Object.entries(environment)
    .filter(([key]) => allowed.has(key.toLowerCase())));
  result.PYTHONNOUSERSITE = "1";
  return result;
}

export async function runVmPmoOffline({ mode, pythonPath, packageRoot, contextPath,
  signal, timeoutMs = 2 * 60 * 60 * 1000, environment = process.env,
  ffprobePath = "ffprobe", ffmpegPath = "ffmpeg", onStarted = null,
  expectedBound: frozenBound = null } = {}) {
  if (!["plan", "render"].includes(mode) || typeof pythonPath !== "string"
    || !path.isAbsolute(pythonPath) || typeof packageRoot !== "string"
    || !path.isAbsolute(packageRoot) || !Number.isSafeInteger(timeoutMs)
    || timeoutMs < 1 || timeoutMs > 2_147_483_647
    || (onStarted !== null && typeof onStarted !== "function")) throw failure("VM_PMO_RUN_INPUT_INVALID");
  if (signal?.aborted) throw failure("VM_PMO_RUN_INTERRUPTED");
  const expectedBound = await validateVmPmoInput({ contextPath, signal, expectedBound: frozenBound });
  const { context } = expectedBound;
  let expectedPlan;
  if (mode === "render") {
    expectedPlan = await validateVmPmoPlan({ contextPath, signal, ffprobePath, expectedBound,
      timeoutMs: Math.min(timeoutMs, 120_000) });
    if (expectedPlan.status === "blocked") return { ...expectedPlan, receiptPath: context.plan_result_path, exitCode: 0 };
  }
  let root;
  try {
    const [rootInfo, pythonInfo] = await Promise.all([lstat(packageRoot), lstat(pythonPath)]);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()
      || !pythonInfo.isFile() || pythonInfo.isSymbolicLink()) throw new Error("not trusted");
    root = await realpath(packageRoot);
    if (root !== packageRoot || await realpath(pythonPath) !== pythonPath) throw new Error("not canonical");
    if (!(await regularFile(path.join(context.run_dir, "input.json")))) throw new Error("missing input");
    if (mode === "render" && !(await regularFile(context.plan_path))) throw new Error("missing plan");
  } catch { throw failure("VM_PMO_RUN_INPUT_INVALID"); }
  const receiptPath = mode === "plan" ? context.plan_result_path : context.result_path;
  try { await lstat(receiptPath); throw failure("VM_PMO_RUN_INPUT_INVALID"); }
  catch (error) { if (error?.code !== "ENOENT") throw error; }
  const args = ["-m", "auto_cut_slicing.vm_pmo", mode, "--input",
    path.join(context.run_dir, "input.json"), "--context", contextPath];
  if (mode === "render") args.push("--plan", context.plan_path);
  const child = spawn(pythonPath, args, { cwd: root, env: processEnvironment(environment),
    windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "ignore", "ignore"] });
  let stopped;
  let grace;
  let resolveStopped;
  const stopping = new Promise((resolve) => { resolveStopped = resolve; });
  const stop = (code) => {
    if (stopped) return;
    stopped = failure(code);
    resolveStopped();
    signalProcessTree(child, "SIGTERM");
    grace = setTimeout(() => signalProcessTree(child, "SIGKILL"), 2_000);
    if (process.platform === "win32") grace.unref();
  };
  const abort = () => stop("VM_PMO_RUN_INTERRUPTED");
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  const deadline = setTimeout(() => stop("VM_PMO_RUN_TIMEOUT"), timeoutMs);
  let startEvidence = Promise.resolve();
  child.once("spawn", () => {
    if (!onStarted) return;
    startEvidence = Promise.resolve().then(() => onStarted({ mode, pid: child.pid,
      startedAt: new Date().toISOString() })).catch(() => stop("VM_PMO_START_EVIDENCE_FAILED"));
  });
  let exitCode;
  try {
    exitCode = await new Promise((resolve, reject) => {
      child.once("error", () => reject(failure("VM_PMO_PROCESS_UNAVAILABLE")));
      child.once("close", (code) => resolve(code ?? 1));
    });
    await Promise.race([startEvidence, stopping]);
  } finally {
    clearTimeout(deadline);
    if (!stopped || process.platform === "win32") clearTimeout(grace);
    signal?.removeEventListener("abort", abort);
  }
  if (stopped) throw stopped;
  if (exitCode !== 0) throw failure("VM_PMO_PROCESS_FAILED");
  try { if (!(await regularFile(receiptPath))) throw new Error("not regular"); }
  catch { throw failure("VM_PMO_RECEIPT_MISSING"); }
  const validated = mode === "plan" ? await validateVmPmoPlan({ contextPath, signal, ffprobePath,
    timeoutMs: Math.min(timeoutMs, 120_000), expectedBound })
    : await validateVmPmoRender({ contextPath, ffprobePath, ffmpegPath,
      timeoutMs: Math.min(timeoutMs, 120_000), signal, expectedBound, expectedPlan });
  return { ...validated, receiptPath, exitCode };
}
