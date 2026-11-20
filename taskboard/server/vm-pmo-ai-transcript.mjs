import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";

/** Read-only view of a VM/PMO run's AI planning sessions (`<runRoot>/ai-sessions/<attempt>-session-N/`):
 * what the AI said while working, the commands it ran with trimmed output, and its final report.
 * Display only — nothing here decides planning or delivery — and every value is bounded plain text
 * so a session transcript cannot inject markup or return huge payloads. */
const SESSION_NAME = /^(attempt-\d{1,4})-session-(\d{1,4})$/u;
const MAX_SESSIONS = 40;
const MAX_EVENTS_BYTES = 8 * 1024 * 1024;
const MAX_SMALL_FILE_BYTES = 256 * 1024;
const MAX_STEPS = 400;
const MESSAGE_LIMIT = 8 * 1024;
const COMMAND_LIMIT = 2 * 1024;
const OUTPUT_LIMIT = 2 * 1024;
const REPORT_LIMIT = 64 * 1024;

function object(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function bounded(value, limit) {
  if (typeof value !== "string") return null;
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
}
function stamp(value) { return typeof value === "string" && !Number.isNaN(Date.parse(value)) ? value : null; }

async function readRegular(file, limit) {
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > limit) return null;
    return await readFile(file, "utf8");
  } catch { return null; }
}

function step(item) {
  if (!object(item)) return null;
  if (item.type === "agent_message") return { kind: "message", text: bounded(item.text, MESSAGE_LIMIT) };
  if (item.type === "reasoning") return { kind: "reasoning", text: bounded(item.text, MESSAGE_LIMIT) };
  if (item.type === "command_execution") {
    return { kind: "command", command: bounded(item.command, COMMAND_LIMIT),
      exitCode: Number.isSafeInteger(item.exit_code) ? item.exit_code : null,
      output: bounded(item.aggregated_output, OUTPUT_LIMIT) };
  }
  if (item.type === "file_change" && Array.isArray(item.changes)) {
    return { kind: "file_change", files: item.changes.slice(0, 20)
      .map((change) => bounded(change?.path, 500)).filter(Boolean) };
  }
  if (item.type === "error") return { kind: "error", text: bounded(item.message, MESSAGE_LIMIT) };
  return null;
}

function steps(text) {
  const result = [];
  let truncated = false;
  for (const line of (text ?? "").split("\n")) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event?.type !== "item.completed") continue;
    const row = step(event.item);
    if (!row || (row.kind !== "command" && row.kind !== "file_change" && !row.text)) continue;
    if (result.length >= MAX_STEPS) { truncated = true; break; }
    result.push(row);
  }
  return { steps: result, truncated };
}

async function session(root, name, attempt, number) {
  const directory = path.join(root, name);
  const [events, report, outcomeText] = await Promise.all([
    readRegular(path.join(directory, "events.jsonl"), MAX_EVENTS_BYTES),
    readRegular(path.join(directory, "report.txt"), REPORT_LIMIT * 4),
    readRegular(path.join(directory, "outcome.json"), MAX_SMALL_FILE_BYTES)]);
  let outcome = null;
  try { outcome = outcomeText === null ? null : JSON.parse(outcomeText); } catch {}
  if (!object(outcome)) outcome = null;
  const parsed = steps(events);
  return { name, attempt, session: number,
    outcome: bounded(outcome?.outcome, 40), model: bounded(outcome?.model, 128),
    resumed: typeof outcome?.resumed_from === "string",
    startedAt: stamp(outcome?.started_at), finishedAt: stamp(outcome?.finished_at),
    report: bounded(report?.trim() || null, REPORT_LIMIT),
    eventsMissing: events === null, steps: parsed.steps, truncated: parsed.truncated };
}

/** Sessions of a run root, oldest first; `[]` when the run never started an AI session. */
export async function readVmPmoAiTranscript(runRoot) {
  if (typeof runRoot !== "string" || !path.isAbsolute(runRoot)) return [];
  const root = path.join(runRoot, "ai-sessions");
  try {
    const info = await lstat(root);
    if (!info.isDirectory() || info.isSymbolicLink()) return [];
  } catch { return []; }
  const names = [];
  for (const name of await readdir(root).catch(() => [])) {
    const match = SESSION_NAME.exec(name);
    if (match) names.push({ name, attempt: match[1], number: Number(match[2]),
      order: Number(match[1].slice("attempt-".length)) });
  }
  names.sort((left, right) => left.order - right.order || left.number - right.number);
  return Promise.all(names.slice(-MAX_SESSIONS)
    .map(({ name, attempt, number }) => session(root, name, attempt, number)));
}
