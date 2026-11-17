import { spawn } from "node:child_process";
import { VM_APPROVAL_ORIGIN } from "./vm-approval-client.mjs";

/**
 * Opens a Shadow login URL in the default browser of the computer running Taskboard.
 * Only the fixed Shadow origin is accepted; the URL carries a one-time loopback callback.
 */
export function openVmLoginPage(url, { platform = process.platform, spawnProcess = spawn } = {}) {
  let parsed;
  try { parsed = new URL(url); } catch { return Promise.resolve(false); }
  if (parsed.origin !== VM_APPROVAL_ORIGIN || parsed.username || parsed.password) return Promise.resolve(false);
  const command = platform === "win32" ? "explorer.exe" : platform === "darwin" ? "/usr/bin/open" : "xdg-open";
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnProcess(command, [parsed.href], { detached: true, stdio: "ignore", windowsHide: false });
    } catch { resolve(false); return; }
    child.once("error", () => resolve(false));
    child.once("spawn", () => { child.unref?.(); resolve(true); });
  });
}
