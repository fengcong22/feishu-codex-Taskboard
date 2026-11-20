import { lstat, readFile } from "node:fs/promises";
import path from "node:path";

/** Read-only summary of a v3 run for the approval view: the plan receipt's coverage and blockers and
 * the QA items a human still has to check. Display only — it never decides delivery (the validator
 * does) and it returns bounded, plain text so package output cannot inject markup or huge payloads. */
const MAX_JSON_BYTES = 1024 * 1024;
const TEXT_LIMIT = 500;
const LIST_LIMIT = 100;

function object(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function text(value) { return typeof value === "string" ? value.slice(0, TEXT_LIMIT) : null; }
function integer(value) { return Number.isSafeInteger(value) ? value : null; }
function code(value) { return typeof value === "string" && /^[A-Z][A-Z0-9_]{1,100}$/u.test(value) ? value : null; }

async function readJson(file) {
  if (typeof file !== "string") return null;
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_JSON_BYTES) return null;
    const value = JSON.parse(await readFile(file, "utf8"));
    return object(value) ? value : null;
  } catch { return null; }
}

function coverageRow(row) {
  if (!object(row)) return null;
  return { instructionId: text(row.span?.instruction_id), quote: text(row.quote),
    disposition: text(row.disposition), reason: text(row.reason),
    intentIds: Array.isArray(row.intent_ids) ? row.intent_ids.slice(0, 20).map(text).filter(Boolean) : [] };
}

function blockerRow(row) {
  if (!object(row)) return null;
  return { code: code(row.code), rule: text(row.rule), message: text(row.message), path: text(row.path),
    quotes: Array.isArray(row.spans) ? row.spans.slice(0, 10).map((span) => text(span?.quote)).filter(Boolean) : [],
    missingEvidence: Array.isArray(row.missing_evidence) ? row.missing_evidence.slice(0, 10).map(text).filter(Boolean) : [],
    candidateCount: Array.isArray(row.candidates) ? row.candidates.length : 0 };
}

function visualRow(row) {
  const base = qaRow(row);
  return { ...base, frames: Array.isArray(row.frames) ? row.frames.slice(0, 10).map(text).filter(Boolean) : [] };
}

const VERDICTS = new Set(["clean", "defect", "unclear"]);

/** One answer of the AI picture review: what it saw at a check, for the operator to compare. */
function verdictRow(item) {
  if (!object(item) || !VERDICTS.has(item.verdict)) return null;
  return { checkId: text(item.check_id), questionId: text(item.question_id), verdict: item.verdict,
    observation: text(item.observation),
    frames: Array.isArray(item.frames) ? item.frames.slice(0, 10).map(text).filter(Boolean) : [] };
}

function qaRow(row) {
  return { checkId: text(row.check_id), kind: text(row.kind), status: text(row.status), method: text(row.method),
    detail: text(row.detail), targetStartUs: integer(row.target_start_us), targetEndUs: integer(row.target_end_us),
    evidenceIds: Array.isArray(row.evidence_ids) ? row.evidence_ids.slice(0, 10).map(text).filter(Boolean) : [] };
}

export async function readVmPmoRunReview(context) {
  if (!object(context) || context.schema_version !== 3) return null;
  const runFile = (name) => typeof context.run_dir === "string" ? path.join(context.run_dir, name) : null;
  const [receipt, report, qaResult, reviewResult, answers] = await Promise.all([readJson(context.plan_result_path),
    readJson(context.qa_path), readJson(runFile("qa-result.json")), readJson(runFile("qa-review-result.json")),
    readJson(context.qa_review_path)]);
  const review = { planningMode: null, planStatus: null, coverage: [], blockers: [], qa: null, qaError: null,
    qaReviewError: null };
  if (reviewResult && reviewResult.status !== "reviewed" && object(reviewResult.error))
    review.qaReviewError = { code: code(reviewResult.error.code), message: text(reviewResult.error.message) };
  if (qaResult && qaResult.status !== "checked" && object(qaResult.error))
    review.qaError = { code: code(qaResult.error.code), message: text(qaResult.error.message) };
  if (receipt) {
    review.planningMode = text(receipt.planning_mode);
    review.planStatus = text(receipt.status);
    if (Array.isArray(receipt.coverage)) review.coverage = receipt.coverage.slice(0, LIST_LIMIT).map(coverageRow).filter(Boolean);
    if (Array.isArray(receipt.blockers)) review.blockers = receipt.blockers.slice(0, LIST_LIMIT).map(blockerRow).filter(Boolean);
  }
  if (report && Array.isArray(report.checks)) {
    const checks = report.checks.filter(object);
    const counts = {};
    for (const row of checks) if (typeof row.status === "string") counts[row.status] = (counts[row.status] ?? 0) + 1;
    review.qa = { overall: text(report.overall), counts,
      // What the picture review concluded, so the operator sees the AI's reading next to the items
      // it left for them. Display only: the validator decides delivery.
      // Shown only once the package merged the review (its receipt says reviewed).
      visualReview: object(report.review) && reviewResult?.status === "reviewed"
        ? { agent: text(report.review.agent), model: text(report.review.model),
          items: Array.isArray(answers?.items) ? answers.items.slice(0, LIST_LIMIT).map(verdictRow).filter(Boolean) : [] }
        : null,
      aiReviewed: checks.filter((row) => row.status === "ai_reviewed").slice(0, LIST_LIMIT).map(visualRow),
      reverseAsr: typeof report.bindings?.output_alignment_sha256 === "string",
      needsHuman: checks.filter((row) => row.status === "needs_human").slice(0, LIST_LIMIT).map(qaRow),
      failed: checks.filter((row) => row.status === "failed").slice(0, LIST_LIMIT).map(qaRow),
      limitations: Array.isArray(report.limitations) ? report.limitations.slice(0, 20).map(text).filter(Boolean) : [] };
  }
  return review;
}
