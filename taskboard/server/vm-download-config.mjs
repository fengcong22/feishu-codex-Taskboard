import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";
import { VmSourceError } from "./vm-source-transfer.mjs";

function exists(file) {
  try { lstatSync(file); return true; }
  catch (error) { if (error?.code === "ENOENT") return false; throw error; }
}

/** Read a small allowlist without loading secrets into child-process environments. */
export function resolveVmDownloadConfig({ dataDirectory, environment = {}, envFile, statePath } = {}) {
  try {
    let local = {};
    if (envFile && exists(envFile)) {
      const info = lstatSync(envFile);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 128 * 1024) throw new Error("invalid config");
      local = parseEnv(readFileSync(envFile, "utf8"));
    }
    const value = key => environment[key] ?? local[key];
    const configured = statePath ?? value("CODEX_VM_APPROVAL_STATE");
    const normal = path.join(dataDirectory, "vm-approval.sqlite");
    const legacy = path.join(path.dirname(dataDirectory), "vm-download-check", "approval-workflow.sqlite");
    if (!configured && exists(normal) && exists(legacy)) throw new VmSourceError("VM_DOWNLOAD_STATE_AMBIGUOUS");
    const selected = configured || (exists(legacy) ? legacy : normal);
    if (!path.isAbsolute(selected)) throw new Error("invalid state path");
    return { statePath: selected, appId: value("FEISHU_APP_ID"), appSecret: value("FEISHU_APP_SECRET"),
      vmPmoPythonPath: value("CODEX_VM_PMO_PYTHON_PATH"), vmPmoRunRoot: value("CODEX_VM_PMO_RUN_ROOT"),
      privateEndpoints: value("CODEX_VM_DOWNLOAD_PRIVATE_ENDPOINTS_JSON") ? JSON.parse(value("CODEX_VM_DOWNLOAD_PRIVATE_ENDPOINTS_JSON")) : [] };
  } catch (error) {
    if (error instanceof VmSourceError) throw error;
    throw new VmSourceError("VM_DOWNLOAD_CONFIG_INVALID");
  }
}
