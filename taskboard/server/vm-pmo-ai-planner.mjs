import { createHash } from "node:crypto";
import { lstat, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { normalizeCodexEvent, spawnCodexTurn } from "./ai-chat-process.mjs";
import { signalProcessTree } from "../shared/process-tree.mjs";

const TEMPLATE_FILE = path.join("docs", "prompts", "taskboard-ai-editing.md");
const TEMPLATE_HEADING = "## Taskboard 自动调度";
const MODEL = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;
const EFFORT = /^[a-z][a-z0-9_-]{0,31}$/u;
const REPORT_LIMIT = 8_000;
const TRANSCRIPT_LIMIT = 4 * 1024 * 1024;
export const VM_PMO_AI_TIMEOUT_MS = 15 * 60 * 1000;

function failure(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function regularFileHash(file) {
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) return "irregular";
    return sha(await readFile(file));
  } catch (error) {
    return error?.code === "ENOENT" ? null : "unreadable";
  }
}

async function absent(file) {
  try { await lstat(file); return false; } catch (error) { return error?.code === "ENOENT"; }
}

/** The package owns the launch prompt; Taskboard only fills in its own absolute paths. */
export async function readVmPmoAiPrompt({ packageRoot, runDir, pythonPath }) {
  let markdown;
  try { markdown = await readFile(path.join(packageRoot, TEMPLATE_FILE), "utf8"); }
  catch { throw failure("VM_PMO_AI_PROMPT_UNAVAILABLE"); }
  const section = markdown.split(TEMPLATE_HEADING)[1];
  const block = section?.match(/```text\r?\n([\s\S]*?)\r?\n```/u)?.[1];
  if (!block) throw failure("VM_PMO_AI_PROMPT_UNAVAILABLE");
  const filled = block.replaceAll("<package_root>", packageRoot).replaceAll("<run_dir>", runDir);
  if (/<package_root>|<run_dir>/u.test(filled)) throw failure("VM_PMO_AI_PROMPT_UNAVAILABLE");
  return [
    filled,
    "",
    `Python 解释器：${pythonPath}（运行证据命令时使用这个解释器，不要用 PATH 上的 python）。`,
  ].join("\n");
}

export function buildVmPmoAiArgs({ runDir, model, reasoningEffort }) {
  const args = ["exec", "--json", "--color", "never", "--skip-git-repo-check", "-C", runDir,
    "-s", "workspace-write", "-c", 'approval_policy="never"',
    "-c", "sandbox_workspace_write.network_access=false"];
  if (model !== null && model !== undefined) {
    if (typeof model !== "string" || !MODEL.test(model)) throw failure("VM_PMO_AI_MODEL_INVALID");
    args.push("-m", model);
  }
  if (reasoningEffort !== null && reasoningEffort !== undefined) {
    if (typeof reasoningEffort !== "string" || !EFFORT.test(reasoningEffort)) throw failure("VM_PMO_AI_MODEL_INVALID");
    args.push("-c", `model_reasoning_effort="${reasoningEffort}"`);
  }
  args.push("-");
  return args;
}

// Codex keeps its own login, proxy and PATH variables; Taskboard, Bridge, Feishu, Shadow and
// Auto-Cut credentials are never handed to the editing session.
const AI_ENV_DENIED_PREFIXES = ["CODEX_AUTOCUT_", "CODEX_FEISHU_", "CODEX_TASKBOARD_", "CODEX_VM_",
  "FEISHU_", "LARK_", "SHADOW_", "PMO_", "VM_", "TASKBOARD_"];

export function vmPmoAiEnvironment(environment) {
  return Object.fromEntries(Object.entries(environment).filter(([key]) => {
    const name = key.toUpperCase();
    return !AI_ENV_DENIED_PREFIXES.some((prefix) => name.startsWith(prefix));
  }));
}

/**
 * Starts one unattended Codex turn in the attempt directory, which is the only writable root.
 * The model may read the package and gather evidence, then write edit-intent.json. It must not
 * plan, render or touch the files Taskboard and analyze wrote; any such change blocks the run.
 */
export async function runVmPmoAiPlanning({ codexExecutable, packageRoot, pythonPath, context,
  model = null, reasoningEffort = null, timeoutMs = VM_PMO_AI_TIMEOUT_MS, environment = process.env,
  signal, onStarted = null, transcriptPath, spawnTurn = spawnCodexTurn } = {}) {
  const runDir = context?.run_dir;
  if (typeof codexExecutable !== "string" || !codexExecutable
    || ![packageRoot, pythonPath, runDir, transcriptPath].every((file) => typeof file === "string" && path.isAbsolute(file))
    || path.dirname(transcriptPath) !== path.dirname(runDir)
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647
    || (onStarted !== null && typeof onStarted !== "function")) throw failure("VM_PMO_AI_INPUT_INVALID");
  if (signal?.aborted) throw failure("VM_PMO_RUN_INTERRUPTED");
  const protectedFiles = [path.join(runDir, "input.json"), path.join(runDir, "execution-context.json"),
    context.intent_context_path, context.analyze_result_path, path.join(runDir, "alignment.words.json")];
  const forbidden = [context.intent_path, context.plan_path, context.plan_result_path, context.result_path,
    context.output_path, path.join(runDir, "qa-result.json"), context.qa_path];
  const before = await Promise.all(protectedFiles.map(regularFileHash));
  if (before.some((value) => !/^[a-f0-9]{64}$/u.test(value ?? "")))
    throw failure("VM_PMO_AI_INPUT_INVALID");
  for (const file of forbidden) if (!(await absent(file))) throw failure("VM_PMO_AI_INPUT_INVALID");
  if (!(await absent(transcriptPath))) throw failure("VM_PMO_AI_INPUT_INVALID");
  const prompt = await readVmPmoAiPrompt({ packageRoot, runDir, pythonPath });
  const args = buildVmPmoAiArgs({ runDir, model, reasoningEffort });

  const transcript = [];
  let transcriptBytes = 0;
  let codexThreadId = null;
  let report = "";
  const record = (entry) => {
    const line = JSON.stringify({ at: new Date().toISOString(), ...entry });
    if (transcriptBytes + line.length > TRANSCRIPT_LIMIT) return;
    transcript.push(line);
    transcriptBytes += line.length + 1;
  };
  let spawned;
  try {
    spawned = spawnTurn({ executable: codexExecutable, args, prompt, env: vmPmoAiEnvironment(environment),
      onRawEvent: (raw) => {
        const event = normalizeCodexEvent(raw);
        if (!event) return;
        if (event.kind === "thread.started") { codexThreadId = event.threadId; return; }
        record({ type: event.type, role: event.role, content: event.content });
        if (event.type === "agent_message" && typeof event.content === "string" && event.content.trim())
          report = event.content.slice(0, REPORT_LIMIT);
      } });
  } catch { throw failure("VM_PMO_AI_PROCESS_UNAVAILABLE"); }
  const { child, completion } = spawned;
  const startedAt = new Date().toISOString();
  let stopped = null;
  const stop = (code) => {
    if (stopped) return;
    stopped = code;
    signalProcessTree(child, "SIGKILL");
  };
  const abort = () => stop("VM_PMO_RUN_INTERRUPTED");
  signal?.addEventListener("abort", abort, { once: true });
  const deadline = setTimeout(() => stop("VM_PMO_AI_TIMEOUT"), timeoutMs);
  let exitCode = null;
  let processError = null;
  try {
    if (onStarted) await onStarted({ pid: child.pid, startedAt });
    ({ exitCode } = await completion);
  } catch (error) {
    processError = error;
  } finally {
    clearTimeout(deadline);
    signal?.removeEventListener("abort", abort);
  }
  if (processError && !stopped) stop("VM_PMO_AI_FAILED");
  await completion.catch(() => {});
  const finishedAt = new Date().toISOString();
  record({ type: "taskboard.finished", role: "activity",
    content: stopped ?? (exitCode === 0 ? "completed" : `exit ${exitCode}`) });
  try { await writeFile(transcriptPath, `${transcript.join("\n")}\n`, { flag: "wx" }); } catch {}
  if (stopped === "VM_PMO_RUN_INTERRUPTED") throw failure("VM_PMO_RUN_INTERRUPTED");

  const session = { codexThreadId, startedAt, finishedAt, exitCode, report,
    transcriptFile: path.basename(transcriptPath) };
  const after = await Promise.all(protectedFiles.map(regularFileHash));
  const leaked = (await Promise.all(forbidden.slice(1).map(absent))).some((ok) => !ok);
  if (after.some((value, index) => value !== before[index]) || leaked)
    return { status: "blocked", errorCode: "VM_PMO_AI_SCOPE_VIOLATION", session };
  if (stopped) return { status: "blocked", errorCode: stopped, session };
  if (exitCode !== 0) return { status: "blocked", errorCode: "VM_PMO_AI_FAILED", session };
  const intentSha256 = await regularFileHash(context.intent_path);
  if (intentSha256 === null) return { status: "blocked", errorCode: "INTENT_MISSING", session };
  if (!/^[a-f0-9]{64}$/u.test(intentSha256)) return { status: "blocked", errorCode: "INTENT_INVALID", session };
  return { status: "ready", intentSha256, session };
}
