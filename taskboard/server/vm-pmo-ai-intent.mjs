import path from "node:path";

import { spawnCodexTurn } from "./ai-chat-process.mjs";
import { isVmPmoAiProviderFailure, readVmPmoAiProviderFailure, runCodexSession, vmPmoAiEnvironment }
  from "./vm-pmo-ai-session.mjs";

/** Step 2 of VM/PMO v3: one unattended Codex session writes edit-intent.json for a run.
 * Decided 2026-11-17: 15 minutes, no automatic retry, and a timeout or a missing intent is a
 * block for a human to rerun; Taskboard never falls back to guessing with the fixed patterns. */
export const AI_INTENT_TIMEOUT_MS = 15 * 60 * 1000;
export const AI_INTENT_AGENT = "codex";
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const THREAD = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/u;

export { isVmPmoAiProviderFailure, readVmPmoAiProviderFailure, vmPmoAiEnvironment };

function failure(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

export function validVmPmoAiModel(value) {
  return typeof value === "string" && MODEL.test(value);
}

/** The package's Taskboard prompt (docs/prompts/taskboard-ai-editing.md) with absolute locations.
 * Rules stay in the package documents; this text only points to them and states the boundary. */
export function buildVmPmoAiIntentPrompt({ packageRoot, pythonPath, context, history = null, resumed = false }) {
  const doc = (name) => path.join(packageRoot, ...name.split("/"));
  const previous = history?.parentRunDir ? [
    "",
    "上一轮（只读参考，不要写入）：",
    `- 上一轮运行目录：${history.parentRunDir}`,
    `- 上一轮剪辑意图：${path.join(history.parentRunDir, "edit-intent.json")}`,
    `- 上一轮计划与质检：${path.join(history.parentRunDir, "plan.json")}、${path.join(history.parentRunDir, "qa.json")}`,
    ...(history.rebased ? [
      "- 本轮在原视频上重新剪整条视频（不是在上一轮成片上改）。上一轮的 edit-intent.json 就在原视频时间轴上，",
      "  可以以它为起点修改：保留仍然有效的处理，按新意见调整，被上一轮剪掉、现在要加回的内容可以直接从原视频取。",
      "- input.json 的 instructions 包含全部轮次的意见，每条都要在覆盖表里处理；后一轮与前一轮冲突时以后一轮为准，",
      "  被取代的部分写 context 并说明。",
      "- 审核意见里写的时间是审核人看的那一稿上的时间。intent-context 里这些意见带 time_map（那一稿的片段表）：",
      "  引用这类时间（user_anchor）时，value_us 写按片段表换算后的原视频时间，validator 会按同一张表复核。",
    ] : [
      "- 本轮的源视频就是上一轮交付的成片，时间以本轮源视频为准；input.json 的 prior_rounds 里有以往各轮的原意见。",
    ]),
  ] : [];
  const images = history?.imagePaths?.length ? [
    "",
    "审核截图（已作为图片附在本条消息里，文件也在运行目录中，供对照意见理解画面位置）：",
    ...history.imagePaths.map((file) => `- ${file}`),
    "截图只用来理解意见指的是哪里；时间和画面仍须用证据命令取证，不能凭截图估计时间。",
  ] : [];
  return [
    resumed
      ? "这是同一条记录的新一轮审核修改。你在上一轮写过这条视频的剪辑意图；请沿用你对素材和规则的理解，按新的意见在本轮运行目录重新完成规划。"
      : "你在为 auto-cut-slicing 执行一次 VM/PMO 剪辑规划。",
    "",
    `包仓库：${packageRoot}（只读；下面提到的文档都在这里）`,
    `运行目录：${context.run_dir}（你的工作目录，唯一可写的位置）`,
    `输入：${path.join(context.run_dir, "input.json")}`,
    `上下文：${path.join(context.run_dir, "execution-context.json")}`,
    `意图上下文：${context.intent_context_path}（证据命令的 --context 用它）`,
    `证据清单：${path.join(context.evidence_dir, "manifest.json")}（已由 analyze 生成，含完整转写 transcript-full）`,
    "",
    "先阅读（路径相对包仓库）：",
    `1. ${doc("AGENTS.md")}`,
    `2. ${doc("docs/editing-standards.md")}`,
    `3. ${doc("docs/ai-editing-workflow.md")}`,
    `4. ${doc("docs/intent-schema.md")}`,
    "",
    "任务：按 docs/ai-editing-workflow.md 第 1–4 步，为 input.json 中的全部 instructions 写出",
    `${context.intent_path}。需要更多证据时只使用工作流“能力状态”表中列出的命令。`,
    "",
    `运行证据命令：包没有安装到 Python 环境，\`${pythonPath} -m auto_cut_slicing ...\` 必须在包仓库目录下执行`,
    `（先 \`Set-Location ${packageRoot}\`，再执行命令），`,
    `\`--context\` 写意图上下文的绝对路径 ${context.intent_context_path}。证据文件会写进 ${context.evidence_dir}${path.sep}。`,
    ...previous,
    ...images,
    "",
    "边界：",
    "- 只在运行目录内写文件，不修改仓库文件，不运行 render，不上传或回写任何系统。",
    "- 这是无人值守运行，不能向用户提问，要把工作做到底：能用证据和剪辑准则确定的就直接处理；",
    "  反复运行 intent validate 直到没有问题。只有准则要求阻断时（做不到、缺证据、多处候选没有区分依据）",
    "  才写 status 为 blocked 的意图文件，并写清人工需要补充什么。",
    "- 时间只能引用 docs/intent-schema.md“时间来源”中的来源。",
    "- 结束时输出一段给审核人看的中文报告（会回写到飞书表格）：每条意见怎么处理、选了哪一处及依据、",
    "  阻断原因和需要人工补充的说明、仍需人工复核的项目。",
    "",
  ].join("\n");
}

/** Returns a runner `({context, packageRoot, pythonPath, sessionDir, signal, onSpawn}) =>
 * {outcome: "completed" | "failed" | "timeout", threadId}`. Interruption throws VM_PMO_RUN_INTERRUPTED.
 * Session evidence (prompt, bounded JSONL events, final report, outcome) goes to sessionDir, which
 * the caller keeps outside the AI-writable run directory. */
export function createVmPmoAiIntentRunner({ codexExecutable, model, environment = process.env, toolDir = null,
  timeoutMs = AI_INTENT_TIMEOUT_MS, spawnTurn = spawnCodexTurn, now = () => new Date() } = {}) {
  if (typeof codexExecutable !== "string" || !codexExecutable.trim() || !validVmPmoAiModel(model)
    || toolDir !== null && (typeof toolDir !== "string" || !path.isAbsolute(toolDir))
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || typeof spawnTurn !== "function")
    throw failure("VM_PMO_AI_NOT_CONFIGURED");
  const session = Object.freeze({ agent: AI_INTENT_AGENT, model });
  async function run({ context, packageRoot, pythonPath, sessionDir, signal, onSpawn = null,
    resumeThreadId = null, history = null } = {}) {
    if (signal?.aborted) throw failure("VM_PMO_RUN_INTERRUPTED");
    if (resumeThreadId !== null && (typeof resumeThreadId !== "string" || !THREAD.test(resumeThreadId)))
      throw failure("VM_PMO_RUN_INPUT_INVALID");
    const images = Array.isArray(history?.imagePaths) ? history.imagePaths : [];
    if (images.some((file) => typeof file !== "string" || !path.isAbsolute(file))) throw failure("VM_PMO_RUN_INPUT_INVALID");
    const prompt = buildVmPmoAiIntentPrompt({ packageRoot, pythonPath, context, history, resumed: Boolean(resumeThreadId) });
    // Evidence commands are local; the session's own shell never needs the network.
    const args = ["exec", "--json", "--color", "never", "--skip-git-repo-check", "-C", context.run_dir,
      "-s", "workspace-write", "-c", 'approval_policy="never"',
      "-c", "sandbox_workspace_write.network_access=false", "-m", model,
      // Review rounds continue the previous round's conversation; images ride along as attachments.
      ...(resumeThreadId ? ["resume"] : []), ...images.flatMap((file) => ["-i", file]),
      ...(resumeThreadId ? [resumeThreadId] : []), "-"];
    return runCodexSession({ executable: codexExecutable, args, prompt,
      env: vmPmoAiEnvironment(environment, { toolDir }), sessionDir, signal, onSpawn, timeoutMs,
      spawnTurn, now, evidence: { agent: session.agent, model: session.model, resumed_from: resumeThreadId,
        images: images.length } });
  }
  return Object.freeze({ session, run });
}
