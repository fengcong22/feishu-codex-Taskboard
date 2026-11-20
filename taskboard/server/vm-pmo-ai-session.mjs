import { appendFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { spawnCodexTurn } from "./ai-chat-process.mjs";
import { signalProcessTree } from "../shared/process-tree.mjs";

/** Unattended Codex turns for VM/PMO: the caller builds the fixed args, this module keeps the
 * boundary everyone shares — no network, no Feishu/VM/bridge/Jira credentials in the environment,
 * one 15-minute style deadline, and session evidence (prompt, bounded JSONL events, final report,
 * result) in `sessionDir`, which lives outside the run directory the AI may write. */
export const EVENT_LOG_LIMIT = 8 * 1024 * 1024;
export const REPORT_LIMIT = 64 * 1024;
// The session reads the package and writes one run directory; it never needs Feishu, VM approval,
// bridge or Jira credentials, so those are removed before Codex starts.
const PRIVATE_ENVIRONMENT = /^(?:FEISHU|LARK|CODEX_FEISHU|CODEX_TASKBOARD|CODEX_AUTOCUT|VM_|JIRA)|SECRET|PASSWORD/iu;

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

// A provider that refuses the request (auth, balance, quota, rate limit, server error) before the
// session did any work is not a planning failure; such a session does not use a human rerun.
const PROVIDER_STATUS = /\bunexpected status (?:40[123]|429|5\d\d)\b/u;
const PROVIDER_CODE = /INSUFFICIENT_BALANCE|insufficient_quota|rate[ _-]?limit|quota exceeded/iu;

/** Folds one Codex event into `{refused, worked}`: refused when an error or failed turn names a
 * provider status; worked when any item other than an error appeared (command, edit, message). */
function providerStep(state, event) {
  if (event?.type === "item.started" || event?.type === "item.completed") {
    if (event.item?.type !== "error") state.worked = true;
  } else if (event?.type === "error" || event?.type === "turn.failed") {
    const message = String(event.type === "error" ? event.message : event.error?.message ?? "");
    if (PROVIDER_STATUS.test(message) || PROVIDER_CODE.test(message)) state.refused = true;
  }
  return state;
}

/** True when the session's events show only a provider refusal and no work. */
export function isVmPmoAiProviderFailure(events) {
  const state = events.reduce(providerStep, { refused: false, worked: false });
  return state.refused && !state.worked;
}

/** Reads a session's bounded events.jsonl; unreadable or malformed lines never count as a refusal. */
export async function readVmPmoAiProviderFailure(sessionDir) {
  let text;
  try { text = await readFile(path.join(sessionDir, "events.jsonl"), "utf8"); } catch { return false; }
  const events = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try { events.push(JSON.parse(line)); } catch { return false; }
  }
  return isVmPmoAiProviderFailure(events);
}

/** Runs one Codex turn and records its evidence. Returns `{outcome, threadId, report}` where
 * `outcome` is `completed`, `failed` or `timeout` (plus `providerFailure`); an interruption throws VM_PMO_RUN_INTERRUPTED.
 * `evidence` is merged into `outcome.json` (model, thread, resumed_from, ...) by the caller. */
export async function runCodexSession({ executable, args, prompt, env, sessionDir, signal,
  onSpawn = null, timeoutMs, evidence = {}, spawnTurn = spawnCodexTurn, now = () => new Date() } = {}) {
  const startedAt = now().toISOString();
  await writeFile(path.join(sessionDir, "prompt.txt"), prompt, { flag: "wx" });
  const eventsPath = path.join(sessionDir, "events.jsonl");
  await writeFile(eventsPath, "", { flag: "wx" });
  let logged = 0, threadId = null, report = "", turnFailed = false;
  const provider = { refused: false, worked: false };
  let writes = Promise.resolve();
  const { child, completion } = spawnTurn({ executable, args, prompt, env,
    onRawEvent: (event) => {
      if (event?.type === "thread.started" && typeof event.thread_id === "string") threadId = event.thread_id.slice(0, 200);
      if (event?.type === "turn.failed" || event?.type === "error") turnFailed = true;
      providerStep(provider, event);
      if (event?.type === "item.completed" && event.item?.type === "agent_message"
        && typeof event.item.text === "string") report = event.item.text.slice(0, REPORT_LIMIT);
      const line = JSON.stringify(event) + "\n";
      if (logged + line.length > EVENT_LOG_LIMIT) return;
      logged += line.length;
      writes = writes.then(() => appendFile(eventsPath, line)).catch(() => {});
    } });
  let stopped = null;
  const stop = (value) => {
    if (stopped) return;
    stopped = value;
    signalProcessTree(child, "SIGKILL");
  };
  const deadline = setTimeout(() => stop("timeout"), timeoutMs);
  const abort = () => stop("interrupted");
  signal?.addEventListener("abort", abort, { once: true });
  if (Number.isSafeInteger(child?.pid) && child.pid > 0 && onSpawn) {
    try { await onSpawn({ pid: child.pid, startedAt }); }
    catch (error) { stop("failed"); await completion.catch(() => {}); throw error; }
  }
  let exit;
  try { exit = await completion; } catch { exit = null; }
  finally {
    clearTimeout(deadline);
    signal?.removeEventListener("abort", abort);
  }
  await writes;
  const outcome = stopped ?? (exit?.exitCode === 0 && !turnFailed ? "completed" : "failed");
  const providerFailure = outcome === "failed" && provider.refused && !provider.worked;
  await writeFile(path.join(sessionDir, "report.txt"), report, { flag: "wx" });
  await writeFile(path.join(sessionDir, "outcome.json"), JSON.stringify({ ...evidence, thread_id: threadId,
    started_at: startedAt, finished_at: now().toISOString(), timeout_ms: timeoutMs,
    outcome, provider_failure: providerFailure, exit_code: exit?.exitCode ?? null }, null, 2) + "\n", { flag: "wx" });
  if (outcome === "interrupted") {
    const error = new Error("VM_PMO_RUN_INTERRUPTED");
    error.code = "VM_PMO_RUN_INTERRUPTED";
    throw error;
  }
  return { outcome, threadId, report, providerFailure };
}
