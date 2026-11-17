import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { runVmPmoOffline } from "./vm-pmo-offline-runner.mjs";
import { validateVmPmoAnalyze, validateVmPmoInput } from "./vm-pmo-result-validator.mjs";

/** Driver vm_pmo_review_video_v3. The orchestrator still sees two steps:
 *  - plan:   analyze -> unattended AI writes edit-intent.json -> package plan
 *  - render: package render -> package qa (reverse ASR on by default)
 * Inputs that are not schema v3 `ai_intent` (v1, v2 and v3 `rule`) run unchanged through
 * runVmPmoOffline. Start evidence is reported once, when the first process of a step spawns. */
export const AI_INTENT_BLOCKS = Object.freeze(["AI_INTENT_TIMEOUT", "AI_INTENT_MISSING", "AI_INTENT_FAILED"]);
// Not rerunnable in the same attempt: the files a rerun would reuse can no longer be trusted.
export const AI_INTENT_SCOPE_VIOLATION = "AI_INTENT_SCOPE_VIOLATION";
const MAX_AI_SESSIONS = 9;

function failure(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

async function present(file) {
  try { await lstat(file); return true; }
  catch (error) { if (error?.code === "ENOENT") return false; throw failure("VM_PMO_RUN_INPUT_INVALID"); }
}

function regularInfo(info) { return info.isFile() && !info.isSymbolicLink() && info.nlink === 1; }

async function regularFile(file) {
  try { return regularInfo(await lstat(file)); } catch { return false; }
}

/** AI sessions live beside the attempt directories (`<runRoot>/<runId>/ai-sessions/`), outside the
 * directory the AI may write, so its transcript and any superseded intent stay as evidence. */
async function nextSessionDir(context) {
  const root = path.join(path.dirname(context.run_dir), "ai-sessions");
  await mkdir(root, { recursive: true });
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink()) throw failure("VM_PMO_RUN_INPUT_INVALID");
  const prefix = `${path.basename(context.run_dir)}-session-`;
  const used = (await readdir(root)).filter((name) => name.startsWith(prefix)).length;
  if (used >= MAX_AI_SESSIONS) throw failure("VM_PMO_AI_SESSION_LIMIT");
  const directory = path.join(root, `${prefix}${used + 1}`);
  await mkdir(directory);
  return directory;
}

async function fileDigest(file) {
  let info;
  try { info = await lstat(file); } catch (error) {
    if (error?.code === "ENOENT") return null;
    return "unreadable";
  }
  if (!regularInfo(info)) return "irregular";
  try { return createHash("sha256").update(await readFile(file)).digest("hex"); } catch { return "unreadable"; }
}

/** The AI may add evidence and write edit-intent.json. Taskboard's input and context, analyze's
 * receipt, intent context and source-bound ASR must keep their bytes, and no planning, render or
 * QA output may appear before the package runs those steps itself. */
function aiBoundary(context) {
  return {
    protected: [path.join(context.run_dir, "input.json"), path.join(context.run_dir, "execution-context.json"),
      context.intent_context_path, context.analyze_result_path, path.join(context.run_dir, "alignment.words.json")],
    outputs: [context.plan_path, context.plan_result_path, context.result_path, context.output_path,
      context.qa_path, context.qa_review_path, path.join(context.run_dir, "qa-result.json")],
  };
}

async function snapshotBoundary(context) {
  const boundary = aiBoundary(context);
  const digests = await Promise.all(boundary.protected.map(fileDigest));
  if (digests.some((value) => !/^[a-f0-9]{64}$/u.test(value ?? ""))) throw failure("VM_PMO_RUN_INPUT_INVALID");
  for (const file of boundary.outputs) if (await present(file)) throw failure("VM_PMO_RUN_INPUT_INVALID");
  return digests;
}

/** Names (relative to the run directory) of protected files that changed and outputs that appeared. */
async function boundaryBreaches(context, before) {
  const boundary = aiBoundary(context);
  const after = await Promise.all(boundary.protected.map(fileDigest));
  const changed = boundary.protected.filter((_, index) => after[index] !== before[index]);
  const outputs = [];
  for (const file of boundary.outputs) if (await fileDigest(file) !== null) outputs.push(file);
  const name = (file) => path.relative(context.run_dir, file);
  return { changed: changed.map(name), outputs: outputs.map(name) };
}

export function isVmPmoAiIntentInput(input) {
  return input?.schema_version === 3 && input.planning_mode === "ai_intent";
}

export async function runVmPmoDriver(options = {}) {
  const { mode, contextPath, signal, expectedBound: frozenBound = null } = options;
  if (!["plan", "render"].includes(mode)) throw failure("VM_PMO_RUN_INPUT_INVALID");
  const bound = await validateVmPmoInput({ contextPath, signal, expectedBound: frozenBound });
  if (!isVmPmoAiIntentInput(bound.input)) {
    const { aiIntent: _aiIntent, reverseAsr: _reverseAsr, ...rest } = options;
    return runVmPmoOffline({ ...rest, expectedBound: bound });
  }
  return mode === "plan" ? planWithIntent({ ...options, expectedBound: bound })
    : renderWithQa({ ...options, expectedBound: bound });
}

function startOnce(onStarted, mode) {
  let reported = false;
  return onStarted ? async (evidence) => {
    if (reported) return;
    reported = true;
    await onStarted({ ...evidence, mode });
  } : null;
}

async function planWithIntent(options) {
  const { aiIntent, reverseAsr: _reverseAsr, onStarted = null, expectedBound, signal, ...step } = options;
  if (typeof aiIntent?.run !== "function") throw failure("VM_PMO_AI_NOT_CONFIGURED");
  const { context, input } = expectedBound;
  const session = input.ai_session;
  if (session.agent !== aiIntent.session?.agent || session.model !== aiIntent.session?.model)
    throw failure("VM_PMO_AI_SESSION_CHANGED");
  const started = startOnce(onStarted, "plan");
  const common = { ...step, expectedBound, signal };
  let analyzed;
  if (await present(context.analyze_result_path)) {
    // A rerun of the AI step reuses this attempt's ASR and evidence; it never reanalyzes.
    analyzed = await validateVmPmoAnalyze({ contextPath: step.contextPath, signal, expectedBound });
  } else {
    analyzed = await runVmPmoOffline({ ...common, mode: "analyze", onStarted: started });
  }
  if (analyzed.status !== "ready") return { status: "blocked", errorCode: analyzed.errorCode };

  // Checked before a session slot is used, so a broken attempt never consumes one.
  const before = await snapshotBoundary(context);
  const sessionDir = await nextSessionDir(context);
  if (await present(context.intent_path)) {
    // An intent left by an interrupted or timed-out session is evidence, not input to this session.
    await rename(context.intent_path, path.join(sessionDir, "superseded-edit-intent.json"));
  }
  const ai = await aiIntent.run({ context, packageRoot: step.packageRoot, pythonPath: step.pythonPath,
    sessionDir, signal, onSpawn: started ? (evidence) => started(evidence) : null });
  if (signal?.aborted) throw failure("VM_PMO_RUN_INTERRUPTED");
  // Checked before the outcome: a timed-out or failed session may still have overstepped.
  const breaches = await boundaryBreaches(context, before);
  if (breaches.changed.length || breaches.outputs.length) {
    // The operator is told to inspect the run; this names exactly what the session touched.
    await writeFile(path.join(sessionDir, "scope-violation.json"), JSON.stringify({ outcome: ai.outcome,
      changed_protected_files: breaches.changed, unexpected_outputs: breaches.outputs }, null, 2) + "\n", { flag: "wx" });
    return { status: "blocked", errorCode: AI_INTENT_SCOPE_VIOLATION };
  }
  const written = await regularFile(context.intent_path);
  if (ai.outcome === "timeout") return { status: "blocked", errorCode: "AI_INTENT_TIMEOUT" };
  if (ai.outcome !== "completed") return { status: "blocked", errorCode: "AI_INTENT_FAILED" };
  if (!written) return { status: "blocked", errorCode: "AI_INTENT_MISSING" };
  return runVmPmoOffline({ ...common, mode: "plan", onStarted: started });
}

async function renderWithQa(options) {
  const { aiIntent: _aiIntent, reverseAsr = true, onStarted = null, ...step } = options;
  if (typeof reverseAsr !== "boolean") throw failure("VM_PMO_RUN_INPUT_INVALID");
  const rendered = await runVmPmoOffline({ ...step, mode: "render", qa: "skip", onStarted });
  if (rendered.status !== "rendered") return rendered;
  const { beforeSpawn: _before, assertBeforeSpawn: _assert, onLaunched: _launched, ...quiet } = step;
  return runVmPmoOffline({ ...quiet, mode: "qa", reverseAsr });
}
