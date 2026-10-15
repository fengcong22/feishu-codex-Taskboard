#!/usr/bin/env node
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { startVmLogin, VmApprovalAuthError } from "../server/vm-approval-auth.mjs";
import { createVmApprovalClient } from "../server/vm-approval-client.mjs";
import { createVmApprovalStore } from "../server/vm-approval-store.mjs";
import {
  enqueueVmApproval, processVmApproval, resumeVmApproval, summarizeVmApproval, validateVmApprovalRequest,
} from "../server/vm-approval-workflow.mjs";
import { VmSourceError } from "../server/vm-source-transfer.mjs";

const DEFAULT_MAX_WAIT_MS = 30 * 60 * 1000;
const MAX_SLEEP_MS = 30_000;
const TERMINAL = new Set(["ready", "rejected", "canceled", "needs_attention", "auth_required", "dead_letter"]);
const HELP = `Usage: node taskboard/cli/vm-approval.mjs enqueue --request FILE --state FILE [--id ID]
       node taskboard/cli/vm-approval.mjs status --state FILE [--id ID]
       node taskboard/cli/vm-approval.mjs tick --state FILE --id ID [--login]
       node taskboard/cli/vm-approval.mjs run --state FILE --id ID [--login] [--max-wait-ms N]
       node taskboard/cli/vm-approval.mjs resume --state FILE --id ID

tick/run also accept --ffprobe ABSOLUTE_PATH and --ffmpeg ABSOLUTE_PATH.
enqueue records a request without contacting VM. tick advances one queued job;
run waits between attempts for up to 30 minutes by default. The wait limit is
checked between operations; an active request or download finishes safely.
Use --login for normal Shadow SSO (10-minute login window), or provide
SHADOW_TOKEN in the process environment. Tokens are never command-line arguments
or output, and .env files are not loaded implicitly. --login prints an
awaiting_login JSON line before the final result. Other results are JSON.
resume restarts auth_required/dead_letter jobs while retaining submission intent.
Ctrl+C stops waiting; restart run/tick with the same state and ID to continue.
Exit codes: 0 command succeeded/ready, 2 invalid request, 3 failed or stopped job,
            4 pending, 5 authentication required, 130 interrupted.
`;

function invalid() { throw new VmSourceError("VM_REQUEST_INVALID"); }
function interrupted() { throw new VmSourceError("VM_APPROVAL_INTERRUPTED"); }

function positiveInteger(value) {
  if (typeof value !== "string" || !/^[1-9]\d*$/u.test(value)) invalid();
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > 2_147_483_647) invalid();
  return parsed;
}

function parse(argv) {
  const command = argv[0];
  const byCommand = {
    enqueue: ["request", "state", "id"], status: ["state", "id"], resume: ["state", "id"],
    tick: ["state", "id", "ffprobe", "ffmpeg", "login"],
    run: ["state", "id", "ffprobe", "ffmpeg", "login", "max-wait-ms"],
  };
  if (!Object.hasOwn(byCommand, command)) invalid();
  const allowed = new Set(byCommand[command]);
  const options = {};
  for (let i = 1; i < argv.length; i += 1) {
    const key = typeof argv[i] === "string" && argv[i].startsWith("--") ? argv[i].slice(2) : "";
    if (!allowed.has(key) || Object.hasOwn(options, key)) invalid();
    if (key === "login") { options.login = true; continue; }
    const value = argv[++i];
    if (typeof value !== "string" || !value || value.startsWith("--") || value.includes("\0")) invalid();
    options[key] = value;
  }
  if (!options.state || (command === "enqueue" && !options.request)
    || (["tick", "run", "resume"].includes(command) && !options.id)) invalid();
  if (options.id && !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u.test(options.id)) invalid();
  for (const tool of ["ffprobe", "ffmpeg"]) if (options[tool] && !path.isAbsolute(options[tool])) invalid();
  options.state = path.resolve(options.state);
  options.maxWaitMs = options["max-wait-ms"] === undefined ? DEFAULT_MAX_WAIT_MS : positiveInteger(options["max-wait-ms"]);
  return { command, options };
}

async function requestFile(filename) {
  try {
    const info = await lstat(filename);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 64 * 1024) invalid();
    return JSON.parse(await readFile(filename, "utf8"));
  } catch { invalid(); }
}

function jobExitCode(job) {
  if (job.status === "ready") return 0;
  if (job.status === "auth_required") return 5;
  return TERMINAL.has(job.status) ? 3 : 4;
}

function requireJob(store, id) {
  const job = store.get(id);
  if (!job) throw new VmSourceError("VM_APPROVAL_JOB_NOT_FOUND");
  return job;
}

async function awaitToken(login, signal) {
  if (signal.aborted) interrupted();
  let onAbort;
  try {
    return await Promise.race([
      login.token,
      new Promise((_, reject) => {
        onAbort = () => reject(new VmSourceError("VM_APPROVAL_INTERRUPTED"));
        signal.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
  } finally { if (onAbort) signal.removeEventListener("abort", onAbort); }
}

export async function main(argv = process.argv.slice(2), {
  stdout = process.stdout,
  env = process.env,
  createStore = createVmApprovalStore,
  createClient = createVmApprovalClient,
  startLogin = startVmLogin,
  validate = validateVmApprovalRequest,
  enqueue = enqueueVmApproval,
  processJob = processVmApproval,
  resume = resumeVmApproval,
  summarize = summarizeVmApproval,
  now = Date.now,
  sleep = (milliseconds, signal) => delay(milliseconds, undefined, { signal }),
  signal,
} = {}) {
  if (argv.length === 1 && argv[0] === "--help") { stdout.write(HELP); return 0; }
  const controller = new AbortController();
  const activeSignal = signal ?? controller.signal;
  const onSigint = () => controller.abort();
  let store;
  let login;
  let outcome;
  let listening = false;
  try {
    const { command, options } = parse(argv);
    if (activeSignal.aborted) interrupted();
    // Validate before creating a queue file so invalid input leaves no partial job.
    const request = command === "enqueue" ? validate(await requestFile(options.request)) : undefined;
    store = createStore({ file: options.state, now });
    if (command === "enqueue") {
      const job = enqueue(store, request, { ...(options.id ? { id: options.id } : {}), now });
      outcome = { output: summarize(job), exitCode: 0 };
    } else if (command === "status") {
      outcome = {
        output: options.id ? summarize(requireJob(store, options.id)) : { jobs: store.list().map(summarize) },
        exitCode: 0,
      };
    } else if (command === "resume") {
      requireJob(store, options.id);
      outcome = { output: summarize(resume(store, options.id, { now })), exitCode: 0 };
    } else {
      let job = requireJob(store, options.id);
      if (!TERMINAL.has(job.status)) {
        if (!signal) { process.on("SIGINT", onSigint); listening = true; }
        let token = env.SHADOW_TOKEN;
        if (options.login) {
          login = await startLogin({ timeoutMs: 10 * 60 * 1000 });
          stdout.write(`${JSON.stringify({ status: "awaiting_login", login_url: login.loginUrl })}\n`);
          token = await awaitToken(login, activeSignal);
        }
        if (typeof token !== "string" || !token.trim()) throw new VmSourceError("VM_AUTH_REQUIRED");
        const client = createClient({ token });
        const started = now();
        const workerOptions = {
          client, now,
          ...(options.ffprobe ? { ffprobePath: options.ffprobe } : {}),
          ...(options.ffmpeg ? { ffmpegPath: options.ffmpeg } : {}),
        };
        while (true) {
          if (activeSignal.aborted) interrupted();
          job = await processJob(store, options.id, workerOptions);
          if (activeSignal.aborted) interrupted();
          if (command === "tick" || TERMINAL.has(job.status)) break;
          const current = now();
          const remaining = options.maxWaitMs - (current - started);
          if (remaining <= 0) break;
          const dueAt = Number.isSafeInteger(job.next_attempt_at) ? job.next_attempt_at : current + 60_000;
          const waitMs = Math.min(MAX_SLEEP_MS, remaining, Math.max(1000, dueAt - current));
          try { await sleep(waitMs, activeSignal); }
          catch (error) { if (activeSignal.aborted) interrupted(); throw error; }
          if (activeSignal.aborted) interrupted();
          if (now() - started >= options.maxWaitMs) break;
        }
      }
      outcome = { output: summarize(job), exitCode: jobExitCode(job) };
    }
  } catch (error) {
    const code = error instanceof VmSourceError || error instanceof VmApprovalAuthError ? error.code : "VM_APPROVAL_FAILED";
    const invalidRequest = ["VM_REQUEST_INVALID", "VM_APPROVAL_REQUEST_INVALID"].includes(code);
    const wasInterrupted = ["VM_APPROVAL_INTERRUPTED", "VM_AUTH_CANCELED"].includes(code);
    const authRequired = code.startsWith("VM_AUTH_") && !wasInterrupted;
    outcome = {
      output: { status: authRequired ? "auth_required" : wasInterrupted ? "interrupted" : "failed", error: { code } },
      exitCode: invalidRequest ? 2 : authRequired ? 5 : wasInterrupted ? 130 : 3,
    };
  } finally {
    if (listening) process.off("SIGINT", onSigint);
    try { await login?.close(); }
    catch { outcome = { output: { status: "failed", error: { code: "VM_APPROVAL_FAILED" } }, exitCode: 3 }; }
    try { store?.close(); }
    catch { outcome = { output: { status: "failed", error: { code: "VM_APPROVAL_STORE_FAILED" } }, exitCode: 3 }; }
  }
  stdout.write(`${JSON.stringify(outcome.output)}\n`);
  return outcome.exitCode;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
