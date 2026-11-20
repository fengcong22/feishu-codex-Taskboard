import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { runVmPmoOffline } from "./vm-pmo-offline-runner.mjs";
import { qaReviewRequestPath, readQaReviewRequest, reviewAttachments } from "./vm-pmo-qa-review.mjs";
import { VM_PMO_QA_BEFORE_REVIEW, VM_PMO_QA_RESULT, VM_PMO_QA_REVIEW_RESULT, VM_PMO_QA_REVIEW_RETRYABLE,
  validateVmPmoAnalyze, validateVmPmoInput, validateVmPmoRender, vmPmoQaReviewable } from "./vm-pmo-result-validator.mjs";

/** Driver vm_pmo_review_video_v3. The orchestrator still sees two steps:
 *  - plan:   analyze -> unattended AI writes edit-intent.json -> package plan
 *  - render: package render -> package qa (reverse ASR on by default) -> an unattended AI reads the
 *            frames QA exported and writes qa-review.json -> package qa-review merges it
 * Two reruns enter the render step later: `qa` (QA again on the same MP4, then its review) and
 * `qa-review` (only the AI's reading of the frames).
 * Inputs that are not schema v3 `ai_intent` (v1, v2 and v3 `rule`) run unchanged through
 * runVmPmoOffline. Start evidence is reported once, when the first process of a step spawns. */
export const AI_INTENT_BLOCKS = Object.freeze(["AI_INTENT_TIMEOUT", "AI_INTENT_MISSING", "AI_INTENT_FAILED",
  "AI_PROVIDER_FAILED"]);
/** The model provider refused the session before it did any work (auth, balance, quota, rate limit). */
export const AI_PROVIDER_FAILED = "AI_PROVIDER_FAILED";
// Not rerunnable in the same attempt: the files a rerun would reuse can no longer be trusted.
export const AI_INTENT_SCOPE_VIOLATION = "AI_INTENT_SCOPE_VIOLATION";
// Step 6 (AI reads the frames QA exported). Same decision as the intent step: a timeout or a
// missing review is a block for a human, never "the frames were probably fine". QA_REVIEW_INVALID is
// the package refusing the file the AI wrote (qa.json unchanged), so a fresh reading may follow.
export const QA_REVIEW_BLOCKS = Object.freeze(["QA_REVIEW_TIMEOUT", "QA_REVIEW_MISSING", "QA_REVIEW_FAILED",
  "QA_REVIEW_INVALID"]);
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
async function nextSessionDir(context, { infix = "session", limit = MAX_AI_SESSIONS } = {}) {
  const root = path.join(path.dirname(context.run_dir), "ai-sessions");
  await mkdir(root, { recursive: true });
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink()) throw failure("VM_PMO_RUN_INPUT_INVALID");
  const prefix = `${path.basename(context.run_dir)}-${infix}-`;
  const used = (await readdir(root)).filter((name) => name.startsWith(prefix)).length;
  if (used >= limit) throw failure("VM_PMO_AI_SESSION_LIMIT");
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
      context.qa_path, context.qa_review_path, path.join(context.run_dir, VM_PMO_QA_RESULT),
      path.join(context.run_dir, VM_PMO_QA_REVIEW_RESULT), path.join(context.run_dir, VM_PMO_QA_BEFORE_REVIEW)],
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
  if (!["plan", "render", "qa", "qa-review"].includes(mode)) throw failure("VM_PMO_RUN_INPUT_INVALID");
  const bound = await validateVmPmoInput({ contextPath, signal, expectedBound: frozenBound });
  // A QA or review rerun checks the MP4 already rendered for this plan; only AI intent runs have QA.
  if (mode === "qa" || mode === "qa-review") {
    if (!isVmPmoAiIntentInput(bound.input)) throw failure("VM_PMO_RUN_INPUT_INVALID");
    return mode === "qa" ? rerunQa({ ...options, expectedBound: bound })
      : rerunReview({ ...options, expectedBound: bound });
  }
  if (!isVmPmoAiIntentInput(bound.input)) {
    const { aiIntent: _aiIntent, aiQaReview: _aiQaReview, reverseAsr: _reverseAsr, ...rest } = options;
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
  const { aiIntent, aiHistory = null, reverseAsr: _reverseAsr, onStarted = null, expectedBound, signal, ...step } = options;
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
  const history = aiHistory ? { parentRunDir: aiHistory.parentRunDir ?? null, imagePaths: aiHistory.imagePaths ?? [],
    rebased: aiHistory.rebased === true } : null;
  const runSession = (directory, resumeThreadId) => aiIntent.run({ context, packageRoot: step.packageRoot,
    pythonPath: step.pythonPath, sessionDir: directory, signal, resumeThreadId, history,
    onSpawn: started ? (evidence) => started(evidence) : null });
  let ai = await runSession(sessionDir, aiHistory?.resumeThreadId ?? null);
  if (signal?.aborted) throw failure("VM_PMO_RUN_INTERRUPTED");
  // A provider refusal is not a lost conversation: falling back would only discard the thread.
  if (aiHistory?.resumeThreadId && ai.outcome === "failed" && !ai.threadId && !ai.providerFailure) {
    // The earlier conversation could not be reopened (never started a thread); start a fresh one
    // that is pointed at the previous round's files instead.
    await writeFile(path.join(sessionDir, "resume-failed.json"), JSON.stringify({
      resume_thread_id: aiHistory.resumeThreadId }, null, 2) + "\n", { flag: "wx" });
    ai = await runSession(await nextSessionDir(context), null);
    if (signal?.aborted) throw failure("VM_PMO_RUN_INTERRUPTED");
  }
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
  if (ai.outcome === "failed" && ai.providerFailure) return { status: "blocked", errorCode: AI_PROVIDER_FAILED };
  if (ai.outcome !== "completed") return { status: "blocked", errorCode: "AI_INTENT_FAILED" };
  if (!written) return { status: "blocked", errorCode: "AI_INTENT_MISSING" };
  return runVmPmoOffline({ ...common, mode: "plan", onStarted: started });
}

/** The render step: render -> QA -> AI picture review. A missing review runner is not a reason to
 * skip the review — a package that exports frames for a person gets those frames reviewed, and a
 * review that cannot run blocks delivery with the reason shown in the approval view. */
async function renderWithQa(options) {
  const { aiIntent: _aiIntent, aiHistory: _aiHistory, aiQaReview = null, reverseAsr = true, onStarted = null,
    expectedBound, signal, ...step } = options;
  if (typeof reverseAsr !== "boolean") throw failure("VM_PMO_RUN_INPUT_INVALID");
  const rendered = await runVmPmoOffline({ ...step, expectedBound, signal, mode: "render", qa: "skip", onStarted });
  if (rendered.status !== "rendered") return rendered;
  const { beforeSpawn: _before, assertBeforeSpawn: _assert, onLaunched: _launched, ...quiet } = step;
  // The QA receipt is an outcome of its own; never review a report that does not exist.
  const checked = await runVmPmoOffline({ ...quiet, expectedBound, signal, mode: "qa", reverseAsr });
  return reviewQa({ ...quiet, expectedBound, signal, aiQaReview, checked, started: null });
}

/** A QA rerun (the earlier QA files were archived): QA on the same MP4, then its picture review. */
async function rerunQa(options) {
  const { aiIntent: _aiIntent, aiHistory: _aiHistory, aiQaReview = null, reverseAsr = true,
    beforeSpawn: _before, assertBeforeSpawn: _assert, onLaunched: _launched, expectedBound, signal, ...step } = options;
  if (typeof reverseAsr !== "boolean") throw failure("VM_PMO_RUN_INPUT_INVALID");
  const checked = await runVmPmoOffline({ ...step, expectedBound, signal, mode: "qa", reverseAsr });
  const { onStarted: _onStarted, ...quiet } = step;
  return reviewQa({ ...quiet, expectedBound, signal, aiQaReview, checked, started: null });
}

/** A review rerun the operator authorized: the MP4 and QA report stay; only the AI reads the frames
 * again. A receipt in which the package found the review missing or not matching the report is set
 * aside with the stale review file (qa.json was restored, so nothing else moves). The AI session's
 * spawn is this step's start evidence. */
async function rerunReview(options) {
  const { aiIntent: _aiIntent, aiHistory: _aiHistory, aiQaReview = null, reverseAsr: _reverseAsr,
    beforeSpawn: _before, assertBeforeSpawn: _assert, onLaunched: _launched, onStarted = null,
    expectedBound, signal, ...step } = options;
  const { context } = expectedBound;
  const receiptPath = path.join(context.run_dir, VM_PMO_QA_REVIEW_RESULT);
  let sessionDir = null;
  if (await present(receiptPath)) {
    let saved = null;
    try { saved = JSON.parse(await readFile(receiptPath, "utf8")); } catch {}
    if (saved?.status === "blocked" && VM_PMO_QA_REVIEW_RETRYABLE.includes(saved.error?.code)
      && !await present(path.join(context.run_dir, VM_PMO_QA_BEFORE_REVIEW))) {
      sessionDir = await nextSessionDir(context, REVIEW_SESSIONS);
      await rename(receiptPath, path.join(sessionDir, "superseded-qa-review-result.json"));
    }
  }
  const checked = await validateVmPmoRender({ ...step, expectedBound, signal, review: "pending" });
  return reviewQa({ ...step, expectedBound, signal, aiQaReview, checked, sessionDir,
    started: startOnce(onStarted, "qa-review") });
}

// The first review, one after a QA rerun, and two operator reruns.
const REVIEW_SESSIONS = Object.freeze({ infix: "review", limit: 4 });

/** Files the picture review must leave alone: everything delivery is checked against, the QA the
 * package wrote and the frames it exported. Only qa-review.json may appear, and the package's
 * own review outputs may not exist before it runs. */
function reviewBoundary(context, request) {
  const report = path.parse(context.qa_path);
  const frames = [];
  for (const item of request.items) for (const frame of item.frames ?? [])
    if (typeof frame?.path === "string" && path.isAbsolute(frame.path)) frames.push(frame.path);
  return {
    protected: [path.join(context.run_dir, "input.json"), path.join(context.run_dir, "execution-context.json"),
      context.intent_context_path, context.analyze_result_path, context.intent_path, context.plan_path,
      context.plan_result_path, context.result_path, context.qa_path, path.join(context.run_dir, VM_PMO_QA_RESULT),
      path.join(report.dir, `${report.name}-review-request.json`), ...new Set(frames)],
    outputs: [path.join(context.run_dir, VM_PMO_QA_REVIEW_RESULT), path.join(context.run_dir, VM_PMO_QA_BEFORE_REVIEW)],
  };
}

async function reviewBreaches(boundary, before, context) {
  const after = await Promise.all(boundary.protected.map(fileDigest));
  const outputs = [];
  for (const file of boundary.outputs) if (await fileDigest(file) !== null) outputs.push(file);
  const name = (file) => path.relative(context.run_dir, file);
  return { changed: boundary.protected.filter((_, index) => after[index] !== before[index]).map(name),
    outputs: outputs.map(name) };
}

async function reviewQa({ checked, aiQaReview, expectedBound, signal, sessionDir = null, started, ...step }) {
  // A review the package already merged (or refused) is final for this report.
  if (checked.status !== "rendered" || checked.qa?.review) return checked;
  const { context, input } = expectedBound;
  const blocked = (errorCode) => ({ status: "blocked", errorCode, context, input });
  // No picture item needed a person, or QA exported no frame for one: nothing to review.
  if (!vmPmoQaReviewable(checked.qa?.report).length) return checked;
  if (typeof aiQaReview?.run !== "function") return blocked("VM_PMO_AI_NOT_CONFIGURED");
  // The picture review runs on the model frozen into this run; a switched model never reviews.
  if (aiQaReview.session?.agent !== input.ai_session?.agent || aiQaReview.session?.model !== input.ai_session?.model)
    return blocked("VM_PMO_AI_SESSION_CHANGED");
  const request = await readQaReviewRequest(qaReviewRequestPath(context));
  if (request === null || !reviewAttachments(request).length) return blocked("QA_REVIEW_REQUEST_INVALID");
  const boundary = reviewBoundary(context, request);
  const before = await Promise.all(boundary.protected.map(fileDigest));
  if (before.some((value) => !/^[a-f0-9]{64}$/u.test(value ?? ""))) return blocked("QA_REVIEW_REQUEST_INVALID");
  for (const file of boundary.outputs) if (await present(file)) throw failure("VM_PMO_RUN_INPUT_INVALID");
  const directory = sessionDir ?? await nextSessionDir(context, REVIEW_SESSIONS);
  // A review left by a timed-out or rejected session is evidence, not input to this one.
  if (await present(context.qa_review_path))
    await rename(context.qa_review_path, path.join(directory, "superseded-qa-review.json"));
  const ai = await aiQaReview.run({ context, packageRoot: step.packageRoot, pythonPath: step.pythonPath,
    sessionDir: directory, request, qaSha256: checked.qa.qaSha256, signal,
    onSpawn: started ? (evidence) => started(evidence) : null });
  if (signal?.aborted) throw failure("VM_PMO_RUN_INTERRUPTED");
  // Checked before the outcome: a timed-out or failed session may still have overstepped.
  const breaches = await reviewBreaches(boundary, before, context);
  if (breaches.changed.length || breaches.outputs.length) {
    await writeFile(path.join(directory, "scope-violation.json"), JSON.stringify({ outcome: ai.outcome,
      changed_protected_files: breaches.changed, unexpected_outputs: breaches.outputs }, null, 2) + "\n", { flag: "wx" });
    return blocked("QA_REVIEW_SCOPE_VIOLATION");
  }
  if (ai.outcome === "timeout") return blocked("QA_REVIEW_TIMEOUT");
  if (ai.outcome !== "completed") return blocked("QA_REVIEW_FAILED");
  if (!await regularFile(context.qa_review_path)) return blocked("QA_REVIEW_MISSING");
  // The package refuses a review that does not bind this report, these frames and every question.
  return runVmPmoOffline({ ...step, expectedBound, signal, mode: "qa-review" });
}
