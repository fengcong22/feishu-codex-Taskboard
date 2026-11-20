import { readFile } from "node:fs/promises";
import path from "node:path";

import { spawnCodexTurn } from "./ai-chat-process.mjs";
import { runCodexSession, vmPmoAiEnvironment } from "./vm-pmo-ai-session.mjs";

/** Step 6 of VM/PMO v3: one unattended Codex session reads the frames QA exported for its picture
 * items and writes qa-review.json. Same decisions as the intent step (2026-11-17): 15 minutes, no
 * automatic retry, and a timeout or a missing review is a block, never "assume the frames are fine".
 * The package merges the answers itself (`vm_pmo qa-review`); Taskboard checks that the session kept
 * its boundary and that the package's receipt binds the reviewed report. */
export const QA_REVIEW_TIMEOUT_MS = 15 * 60 * 1000;
export const QA_REVIEW_AGENT = "codex";
// Frames ride along as `-i` attachments; past this many the prompt lists the rest by absolute path
// for the session's own image tool, so a long video does not blow up one message.
export const QA_REVIEW_MAX_ATTACHMENTS = 12;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const NAME = /^[^\\/:*?"<>|]{1,200}\.png$/iu;
const SHA256 = /^[a-f0-9]{64}$/u;

function failure(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

/** `vm_pmo qa` writes its review request beside the report it describes (`<stem>-review-request.json`). */
export function qaReviewRequestPath(context) {
  const report = path.parse(context.qa_path);
  return path.join(report.dir, `${report.name}-review-request.json`);
}

/** Which frames to attach: `request.items[].frames[]` are `{file, path, sha256}`; the review file
 * refers to frames by file name, so only the exported names are ever accepted. */
export function reviewAttachments(request) {
  const seen = new Map();
  for (const item of request?.items ?? []) {
    for (const frame of item?.frames ?? []) {
      if (typeof frame?.file !== "string" || !NAME.test(frame.file) || typeof frame.path !== "string"
        || !path.isAbsolute(frame.path) || seen.has(frame.file)) continue;
      seen.set(frame.file, frame.path);
    }
  }
  return [...seen];
}

/** The review request `vm_pmo qa` writes beside qa.json, or null when the file is not one this step
 * can trust. */
export async function readQaReviewRequest(file) {
  let value;
  try { value = JSON.parse(await readFile(file, "utf8")); } catch { return null; }
  if (value?.schema !== "auto-cut-slicing/qa-review-request" || value.schema_version !== 1
    || !Array.isArray(value.items) || typeof value.frames_dir !== "string") return null;
  return value;
}

/** The package's step-6 instructions with absolute locations. Rules stay in the package documents;
 * this text points to them, gives the hashes the review must bind, and states the boundary. */
export function buildVmPmoQaReviewPrompt({ packageRoot, context, request, attachments, qaSha256, model }) {
  const doc = (name) => path.join(packageRoot, ...name.split("/"));
  const listed = (request?.items ?? []).flatMap((item) => [
    "",
    `- ${item.check_id}（${item.kind}）：${item.detail ?? ""}`,
    ...(item.frames ?? []).map((frame) => `  帧：${frame.file}（${frame.path}，sha256 ${frame.sha256}）`),
    ...(item.questions ?? []).map((question) => `  问题 ${question.question_id}：${question.text}`),
  ]);
  const attached = new Set(attachments.map(([file]) => file));
  return [
    "你在为 auto-cut-slicing 复核一次 VM/PMO 成片的画面检查结果。",
    "",
    `包仓库：${packageRoot}（只读；下面提到的文档都在这里）`,
    `运行目录：${context.run_dir}（你的工作目录）`,
    `已有的质检报告：${context.qa_path}（只读，不要修改；它的 SHA-256 是 ${qaSha256}）`,
    `复核请求：${qaReviewRequestPath(context)}（只读）`,
    `帧目录：${typeof request?.frames_dir === "string" ? request.frames_dir : "无"}（只读）`,
    `复核结论的输出：${context.qa_review_path}`,
    `结论结构：${doc("schemas/qa-review.v1.schema.json")}`,
    "",
    "先阅读：",
    `1. ${doc("docs/ai-editing-workflow.md")} 的“QA 检查表”一节`,
    `2. ${doc("schemas/qa-review.v1.schema.json")}`,
    "",
    "需要复核的项：",
    ...(listed.length ? listed : ["（无）"]),
    "",
    "任务：按 docs/ai-editing-workflow.md 第 6 步，逐帧看上面的帧，对每个问题给出 clean、defect 或 unclear，",
    `把结论写到 ${context.qa_review_path}。`,
    ...(attached.size ? [`其中 ${attached.size} 张帧已作为图片附在本条消息里。`] : []),
    ...(attachments.length < reviewAttachments(request).length
      ? ["为了控制单条消息的大小，其余帧没有附上；仍然要用看图工具打开上面列出的路径看过它们再回答。"] : []),
    "",
    "复核文件的要求：",
    `- schema 固定为 "auto-cut-slicing/qa-review"、schema_version 为 1，字段见上面的 schema 文件。`,
    `- qa_sha256 写 ${qaSha256}（当前质检报告的 SHA-256），不要改写成别的值。`,
    `- reviewer 写 {"agent": "codex", "model": "${model}"}。`,
    "- frames_sha256 列出你看过的每一帧：文件名 → 上面给出的 SHA-256；结论里引用的帧必须都在这里。",
    "- items 每个问题一条：check_id、question_id、verdict、observation 都要写；frames 写你据以判断的帧文件名，",
    "  只能是该项列出的帧。",
    "- 每个问题都要回答，一个都不能漏；不要回答不在上面列表里的项。",
    "",
    "边界：",
    "- 只写复核结论这一个文件；不修改质检报告、复核请求、帧或运行目录里的其他任何文件，",
    "  不运行 render、qa 或 qa-review，不上传或回写任何系统。",
    "- 这是无人值守运行，不能向用户提问。看不清、或分不出是不是残留、碎片或闪回时，就写 unclear 并说明缺什么，",
    "  不要猜成 clean；确实看到别的页面内容、残留或闪回时写 defect 并描述在哪里。",
    "- 人工试听与节奏（listening、pacing）不在这次复核范围内。",
    "- 结束时输出一段给审核人看的中文报告：每个画面项看到了什么、给出的结论和依据。",
    "",
  ].join("\n");
}

/** Returns a runner `({context, packageRoot, sessionDir, request, qaSha256, signal, onSpawn}) =>
 * {outcome, threadId, report, providerFailure, attachments}`. Interruption throws VM_PMO_RUN_INTERRUPTED. */
export function createVmPmoQaReviewRunner({ codexExecutable, model, environment = process.env, toolDir = null,
  timeoutMs = QA_REVIEW_TIMEOUT_MS, spawnTurn = spawnCodexTurn, now = () => new Date() } = {}) {
  if (typeof codexExecutable !== "string" || !codexExecutable.trim() || !MODEL.test(model)
    || toolDir !== null && (typeof toolDir !== "string" || !path.isAbsolute(toolDir))
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || typeof spawnTurn !== "function")
    throw failure("VM_PMO_AI_NOT_CONFIGURED");
  const session = Object.freeze({ agent: QA_REVIEW_AGENT, model });
  async function run({ context, packageRoot, sessionDir, request, qaSha256, signal, onSpawn = null } = {}) {
    if (signal?.aborted) throw failure("VM_PMO_RUN_INTERRUPTED");
    if (typeof qaSha256 !== "string" || !SHA256.test(qaSha256)) throw failure("VM_PMO_RUN_INPUT_INVALID");
    const all = reviewAttachments(request);
    const attachments = all.slice(0, QA_REVIEW_MAX_ATTACHMENTS);
    const prompt = buildVmPmoQaReviewPrompt({ packageRoot, context, request, attachments, qaSha256, model });
    // Reviewing is local reading: no network, nothing to run beyond looking at the frames.
    const args = ["exec", "--json", "--color", "never", "--skip-git-repo-check", "-C", context.run_dir,
      "-s", "workspace-write", "-c", 'approval_policy="never"',
      "-c", "sandbox_workspace_write.network_access=false", "-m", model,
      ...attachments.flatMap(([, file]) => ["-i", file]), "-"];
    const result = await runCodexSession({ executable: codexExecutable, args, prompt,
      env: vmPmoAiEnvironment(environment, { toolDir }), sessionDir, signal, onSpawn, timeoutMs,
      spawnTurn, now, evidence: { agent: session.agent, model: session.model, step: "qa_review",
        images: attachments.length } });
    return { ...result, attachments: attachments.map(([file]) => file) };
  }
  return Object.freeze({ session, run });
}
