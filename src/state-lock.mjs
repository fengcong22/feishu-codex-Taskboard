import { createHash } from "node:crypto";
import net from "node:net";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_RETRY_MS = 25;

function positiveInteger(value, name) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
}

function stateLockAddress(identityValue) {
  const identity = process.platform === "win32" ? identityValue.toLowerCase() : identityValue;
  const digest = createHash("sha256").update(identity, "utf8").digest("hex").slice(0, 32);
  if (process.platform === "win32") return `\\\\.\\pipe\\codex-feishu-state-${digest}`;
  if (process.platform === "linux") return `\0codex-feishu-state-${digest}`;
  const error = new Error("State IPC locks are supported only on Windows and Linux");
  error.code = "STATE_LOCK_UNSUPPORTED_PLATFORM";
  throw error;
}

function unsupportedTargetError(detail) {
  const error = new Error(`State lock target is not a stable regular file: ${detail}`);
  error.code = "STATE_LOCK_TARGET_UNSUPPORTED";
  return error;
}

async function inspectTarget(filename) {
  const resolved = path.resolve(filename);
  let metadata;
  try {
    metadata = await lstat(resolved);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    const parent = await realpath(path.dirname(resolved));
    return {
      resolved,
      canonical: path.join(parent, path.basename(resolved)),
      exists: false,
      linkCount: null,
    };
  }
  if (metadata.isSymbolicLink()) throw unsupportedTargetError("symbolic links are not supported");
  if (!metadata.isFile()) throw unsupportedTargetError("target is not a regular file");
  if (Number.isInteger(metadata.nlink) && metadata.nlink > 1) {
    throw unsupportedTargetError("hard-linked aliases are not supported");
  }
  return {
    resolved,
    canonical: await realpath(resolved),
    exists: true,
    linkCount: metadata.nlink,
  };
}

function targetChangedError() {
  const error = new Error("State lock target changed while acquiring the lock");
  error.code = "STATE_LOCK_TARGET_CHANGED";
  return error;
}

async function assertStableTarget(filename, initial) {
  const current = await inspectTarget(filename);
  if (
    current.canonical !== initial.canonical
    || (initial.exists && !current.exists)
    || (initial.exists && current.exists && current.linkCount !== initial.linkCount)
  ) {
    throw targetChangedError();
  }
  return current;
}

function listen(address) {
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => socket.destroy());
    let bound = false;
    const failed = (error) => {
      if (bound) return;
      bound = true;
      server.off("error", failed);
      // A failed bind still owns a server handle until it is closed. Keep a
      // no-op listener while cleanup runs so a late error cannot crash the
      // process, then let the caller retry with a fresh server.
      server.on("error", () => {});
      try {
        server.close(() => reject(error));
      } catch {
        reject(error);
      }
    };
    server.on("error", failed);
    server.listen({ path: address, exclusive: true }, () => {
      bound = true;
      server.off("error", failed);
      // Keep an error listener for post-bind failures. A lock operation must
      // not crash the Bridge from an asynchronous pipe/socket error.
      server.on("error", () => {});
      resolve(server);
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function timeoutError() {
  const error = new Error("Timed out acquiring state lock");
  error.code = "STATE_LOCK_TIMEOUT";
  return error;
}

async function withIpcLock(identity, operation, {
  timeoutMs = DEFAULT_TIMEOUT_MS,
  retryMs = DEFAULT_RETRY_MS,
} = {}, validate = async () => {}) {
  if (typeof operation !== "function") throw new Error("state lock operation must be a function");
  positiveInteger(timeoutMs, "state lock timeoutMs");
  positiveInteger(retryMs, "state lock retryMs");

  const address = stateLockAddress(identity);
  const deadline = performance.now() + timeoutMs;
  let server;
  while (!server) {
    const remaining = deadline - performance.now();
    if (remaining <= 0) throw timeoutError();
    try {
      server = await listen(address);
    } catch (error) {
      if (error.code !== "EADDRINUSE") throw error;
      const retryRemaining = deadline - performance.now();
      if (retryRemaining <= 0) throw timeoutError();
      await delay(Math.min(retryMs, retryRemaining));
    }
  }

  try {
    await validate();
    return await operation();
  } finally {
    await close(server);
  }
}

export async function withStateLock(filename, operation, options = {}) {
  if (typeof filename !== "string" || filename.trim() === "") {
    throw new Error("state lock filename must be a non-empty string");
  }
  if (typeof operation !== "function") throw new Error("state lock operation must be a function");
  const initialTarget = await inspectTarget(filename);
  return withIpcLock(
    `state\u0000${initialTarget.canonical}`,
    operation,
    options,
    () => assertStableTarget(filename, initialTarget),
  );
}

export async function withEventLock(filename, eventId, operation, options = {}) {
  if (typeof filename !== "string" || filename.trim() === "") {
    throw new Error("event lock filename must be a non-empty string");
  }
  if (typeof eventId !== "string" || eventId.trim() === "") {
    throw new Error("event lock eventId must be a non-empty string");
  }
  if (typeof operation !== "function") throw new Error("event lock operation must be a function");
  const initialTarget = await inspectTarget(filename);
  return withIpcLock(
    `event\u0000${initialTarget.canonical}\u0000${eventId}`,
    operation,
    options,
    () => assertStableTarget(filename, initialTarget),
  );
}
