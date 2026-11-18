import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const FILE_VERSION = 1;
const MAX_FILE_BYTES = 64 * 1024;
const USER_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;
// Binds the ciphertext to this purpose so another DPAPI blob of the same user cannot be swapped in.
const ENTROPY = "codex-taskboard:vm-shadow-session:v1";
const POWERSHELL_TIMEOUT_MS = 15_000;

function dpapiScript(operation, entropy = ENTROPY) {
  return [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -AssemblyName System.Security",
    "$data = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())",
    `$entropy = [Text.Encoding]::UTF8.GetBytes('${entropy}')`,
    `$result = [System.Security.Cryptography.ProtectedData]::${operation}($data, $entropy, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)`,
    "[Console]::Out.Write([Convert]::ToBase64String($result))",
  ].join("; ");
}

/** Runs Windows DPAPI for the current Windows user. Secrets travel only on stdin/stdout, never argv. */
function runDpapi(operation, base64, entropy = ENTROPY) {
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-Command", dpapiScript(operation, entropy)], { stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
    let output = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("VM_CREDENTIAL_TIMEOUT")); }, POWERSHELL_TIMEOUT_MS);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0 && /^[A-Za-z0-9+/=]+$/u.test(output)) resolve(output);
      else reject(new Error("VM_CREDENTIAL_PROTECTION_FAILED"));
    });
    child.stdin.end(base64);
  });
}

/** DPAPI bound to one purpose label; a blob protected for one purpose does not decrypt for another. */
export function createWindowsDpapi(entropy) {
  if (typeof entropy !== "string" || !/^[A-Za-z0-9:._-]{1,128}$/u.test(entropy)) throw new Error("DPAPI_ENTROPY_INVALID");
  return Object.freeze({
    available: () => process.platform === "win32",
    protect: (bytes) => runDpapi("Protect", bytes.toString("base64"), entropy).then((value) => Buffer.from(value, "base64")),
    unprotect: (bytes) => runDpapi("Unprotect", bytes.toString("base64"), entropy).then((value) => Buffer.from(value, "base64")),
  });
}

export const windowsDpapi = createWindowsDpapi(ENTROPY);

function validPayload(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    && typeof value.token === "string" && value.token.length > 0 && value.token.length <= 16_384
    && /^[\x21-\x7e]+$/u.test(value.token)
    && typeof value.userId === "string" && USER_ID.test(value.userId)
    && Number.isSafeInteger(value.authorizedAt) && value.authorizedAt > 0;
}

/**
 * Keeps one Shadow session for the current Windows user. Only DPAPI ciphertext reaches disk;
 * where DPAPI is unavailable the store reports unavailable and nothing is written.
 */
export function createVmCredentialStore({ file, protection = windowsDpapi } = {}) {
  if (typeof file !== "string" || !path.isAbsolute(file)
    || typeof protection?.available !== "function" || typeof protection.protect !== "function"
    || typeof protection.unprotect !== "function") throw new Error("VM_CREDENTIAL_STORE_INVALID");
  let queue = Promise.resolve();
  const serial = (operation) => {
    const next = queue.then(operation, operation);
    queue = next.catch(() => {});
    return next;
  };
  const available = () => protection.available() === true;

  async function load() {
    if (!available()) return null;
    let info;
    try { info = await lstat(file); } catch (error) { if (error?.code === "ENOENT") return null; throw error; }
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_FILE_BYTES) return null;
    try {
      const stored = JSON.parse(await readFile(file, "utf8"));
      if (stored?.version !== FILE_VERSION || typeof stored.ciphertext !== "string") return null;
      const payload = JSON.parse((await protection.unprotect(Buffer.from(stored.ciphertext, "base64"))).toString("utf8"));
      return validPayload(payload) ? { token: payload.token, userId: payload.userId, authorizedAt: payload.authorizedAt } : null;
    } catch { return null; }
  }

  async function save(value) {
    if (!available() || !validPayload(value)) return false;
    const plain = Buffer.from(JSON.stringify({ token: value.token, userId: value.userId, authorizedAt: value.authorizedAt }), "utf8");
    const ciphertext = (await protection.protect(plain)).toString("base64");
    plain.fill(0);
    await mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify({ version: FILE_VERSION, ciphertext }), { mode: 0o600, flag: "wx" });
      await rename(temporary, file);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
    return true;
  }

  async function clear() { await rm(file, { force: true }); }

  return Object.freeze({
    available,
    load: () => serial(load),
    save: (value) => serial(() => save(value)),
    clear: () => serial(clear),
  });
}
