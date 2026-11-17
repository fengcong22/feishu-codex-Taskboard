import { spawn } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

import { signalProcessTree } from "../shared/process-tree.mjs";
import { validateVmPmoAnalyze, validateVmPmoInput, validateVmPmoPlan, validateVmPmoQa,
  validateVmPmoRender } from "./vm-pmo-result-validator.mjs";

const MODES = new Set(["analyze", "plan", "render", "qa"]);

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
  beforeSpawn = null, assertBeforeSpawn = null, onLaunched = null,
  expectedBound: frozenBound = null, planSha256 = null, reverseAsr = true } = {}) {
  if (!MODES.has(mode) || typeof pythonPath !== "string"
    || !path.isAbsolute(pythonPath) || typeof packageRoot !== "string"
    || !path.isAbsolute(packageRoot) || !Number.isSafeInteger(timeoutMs)
    || timeoutMs < 1 || timeoutMs > 2_147_483_647
    || (onStarted !== null && typeof onStarted !== "function")
    || (beforeSpawn !== null && typeof beforeSpawn !== "function")
    || (assertBeforeSpawn !== null && typeof assertBeforeSpawn !== "function")
    || (onLaunched !== null && typeof onLaunched !== "function")) throw failure("VM_PMO_RUN_INPUT_INVALID");
  if (signal?.aborted) throw failure("VM_PMO_RUN_INTERRUPTED");
  const expectedBound = await validateVmPmoInput({ contextPath, signal, expectedBound: frozenBound });
  const { context } = expectedBound;
  // analyze and qa belong to the AI planning protocol only.
  if (["analyze", "qa"].includes(mode) && (expectedBound.input.schema_version !== 3
    || expectedBound.input.planning_mode !== "ai_intent")) throw failure("VM_PMO_RUN_INPUT_INVALID");
  if (mode === "qa" && !/^[a-f0-9]{64}$/u.test(planSha256 ?? "")) throw failure("VM_PMO_RUN_INPUT_INVALID");
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
    if (["render", "qa"].includes(mode) && !(await regularFile(context.plan_path))) throw new Error("missing plan");
    if (mode === "qa" && !(await regularFile(context.result_path))) throw new Error("missing render result");
  } catch { throw failure("VM_PMO_RUN_INPUT_INVALID"); }
  const receiptPath = vmPmoReceiptPath(context, mode);
  try { await lstat(receiptPath); throw failure("VM_PMO_RUN_INPUT_INVALID"); }
  catch (error) { if (error?.code !== "ENOENT") throw error; }
  const args = ["-m", "auto_cut_slicing.vm_pmo", mode, "--input",
    path.join(context.run_dir, "input.json"), "--context", contextPath];
  if (mode === "render") args.push("--plan", context.plan_path);
  if (mode === "qa" && reverseAsr) args.push("--reverse-asr");
  if (beforeSpawn) await beforeSpawn();
  if (assertBeforeSpawn) assertBeforeSpawn();
  if (signal?.aborted) throw failure("VM_PMO_RUN_INTERRUPTED");
  let child;
  try { child = spawn(pythonPath, args, { cwd: root, env: processEnvironment(environment),
    windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "ignore", "ignore"] }); }
  catch { throw failure("VM_PMO_PROCESS_UNAVAILABLE"); }
  if (onLaunched && Number.isSafeInteger(child.pid) && child.pid > 0) onLaunched();
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
  const validated = mode === "analyze" ? await validateVmPmoAnalyze({ contextPath, signal, expectedBound })
    : mode === "qa" ? await validateVmPmoQa({ contextPath, signal, expectedBound, planSha256 })
    : mode === "plan" ? await validateVmPmoPlan({ contextPath, signal, ffprobePath,
      timeoutMs: Math.min(timeoutMs, 120_000), expectedBound })
    : await validateVmPmoRender({ contextPath, ffprobePath, ffmpegPath,
      timeoutMs: Math.min(timeoutMs, 120_000), signal, expectedBound, expectedPlan });
  return { ...validated, receiptPath, exitCode };
}

/** The receipt each package command writes exactly once. */
export function vmPmoReceiptPath(context, mode) {
  if (mode === "analyze") return context.analyze_result_path;
  if (mode === "qa") return path.join(context.run_dir, "qa-result.json");
  return mode === "plan" ? context.plan_result_path : context.result_path;
}
