import { appendFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { spawnCodexTurn } from "./ai-chat-process.mjs";
import { signalProcessTree } from "../shared/process-tree.mjs";

/** Step 2 of VM/PMO v3: one unattended Codex session writes edit-intent.json for a run.
 * Decided 2026-11-17: 15 minutes, no automatic retry, and a timeout or a missing intent is a
 * block for a human to rerun; Taskboard never falls back to guessing with the fixed patterns. */
export const AI_INTENT_TIMEOUT_MS = 15 * 60 * 1000;
export const AI_INTENT_AGENT = "codex";
const EVENT_LOG_LIMIT = 8 * 1024 * 1024;
const REPORT_LIMIT = 64 * 1024;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
// The session reads the package and writes one run directory; it never needs Feishu, VM approval,
// bridge or Jira credentials, so those are removed before Codex starts.
const PRIVATE_ENVIRONMENT = /^(?:FEISHU|LARK|CODEX_FEISHU|CODEX_TASKBOARD|CODEX_AUTOCUT|VM_|JIRA)|SECRET|PASSWORD/iu;

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
export function buildVmPmoAiIntentPrompt({ packageRoot, pythonPath, context }) {
  const doc = (name) => path.join(packageRoot, ...name.split("/"));
  return [
    "你在为 auto-cut-slicing 执行一次 VM/PMO 剪辑规划。",
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
    "",
    "边界：",
    "- 只在运行目录内写文件，不修改仓库文件，不运行 render，不上传或回写任何系统。",
    "- 这是无人值守运行，不能向用户提问。需要用户决定、证据不足或能力不支持时，",
    "  写出 status 为 blocked 的意图文件并说明原因。",
    "- 时间只能引用 docs/intent-schema.md“时间来源”中的来源。",
    "- 结束时输出一段简短报告：每条意见的处理方式、阻断原因、仍需人工复核的项目。",
    "",
  ].join("\n");
}

/** On Windows the Codex sandbox runs as a restricted user that cannot open per-user install folders
 * such as WinGet packages, so evidence commands need FFmpeg from a directory it can read (`toolDir`). */
export function vmPmoAiEnvironment(environment = process.env, { toolDir = null } = {}) {
  const result = Object.fromEntries(Object.entries(environment).filter(([key]) => !PRIVATE_ENVIRONMENT.test(key)));
  if (toolDir) {
    const key = Object.keys(result).find((name) => name.toLowerCase() === "path") ?? "PATH";
    result[key] = [toolDir, result[key]].filter(Boolean).join(path.delimiter);
  }
  return result;
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
  async function run({ context, packageRoot, pythonPath, sessionDir, signal, onSpawn = null } = {}) {
    if (signal?.aborted) throw failure("VM_PMO_RUN_INTERRUPTED");
    const prompt = buildVmPmoAiIntentPrompt({ packageRoot, pythonPath, context });
    // Evidence commands are local; the session's own shell never needs the network.
    const args = ["exec", "--json", "--color", "never", "--skip-git-repo-check", "-C", context.run_dir,
      "-s", "workspace-write", "-c", 'approval_policy="never"',
      "-c", "sandbox_workspace_write.network_access=false", "-m", model, "-"];
    const startedAt = now().toISOString();
    await writeFile(path.join(sessionDir, "prompt.txt"), prompt, { flag: "wx" });
    const eventsPath = path.join(sessionDir, "events.jsonl");
    await writeFile(eventsPath, "", { flag: "wx" });
    let logged = 0, threadId = null, report = "", turnFailed = false;
    let writes = Promise.resolve();
    const { child, completion } = spawnTurn({ executable: codexExecutable, args, prompt,
      env: vmPmoAiEnvironment(environment, { toolDir }),
      onRawEvent: (event) => {
        if (event?.type === "thread.started" && typeof event.thread_id === "string") threadId = event.thread_id.slice(0, 200);
        if (event?.type === "turn.failed" || event?.type === "error") turnFailed = true;
        if (event?.type === "item.completed" && event.item?.type === "agent_message"
          && typeof event.item.text === "string") report = event.item.text.slice(0, REPORT_LIMIT);
        const line = JSON.stringify(event) + "\n";
        if (logged + line.length > EVENT_LOG_LIMIT) return;
        logged += line.length;
        writes = writes.then(() => appendFile(eventsPath, line)).catch(() => {});
      } });
    let outcome = null;
    const stop = (value) => {
      if (outcome) return;
      outcome = value;
      signalProcessTree(child, "SIGKILL");
    };
    const deadline = setTimeout(() => stop("timeout"), timeoutMs);
    const abort = () => stop("interrupted");
    signal?.addEventListener("abort", abort, { once: true });
    if (Number.isSafeInteger(child?.pid) && child.pid > 0 && onSpawn) {
      try { await onSpawn({ pid: child.pid, startedAt }); } catch (error) { stop("failed"); await completion.catch(() => {}); throw error; }
    }
    let exit;
    try { exit = await completion; } catch { exit = null; }
    finally {
      clearTimeout(deadline);
      signal?.removeEventListener("abort", abort);
    }
    await writes;
    if (!outcome) outcome = exit?.exitCode === 0 && !turnFailed ? "completed" : "failed";
    await writeFile(path.join(sessionDir, "report.txt"), report, { flag: "wx" });
    await writeFile(path.join(sessionDir, "outcome.json"), JSON.stringify({ agent: session.agent,
      model: session.model, thread_id: threadId, started_at: startedAt, finished_at: now().toISOString(),
      timeout_ms: timeoutMs, outcome, exit_code: exit?.exitCode ?? null }, null, 2) + "\n", { flag: "wx" });
    if (outcome === "interrupted") throw failure("VM_PMO_RUN_INTERRUPTED");
    return { outcome, threadId };
  }
  return Object.freeze({ session, run });
}
