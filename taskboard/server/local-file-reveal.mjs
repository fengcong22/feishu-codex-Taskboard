import { spawn } from "node:child_process";
import path from "node:path";

/**
 * Shows one local file selected in the system file manager of the computer running Taskboard.
 * Callers pass only server-owned paths; this never opens or executes the file itself.
 */
export function revealLocalFile(file, { platform = process.platform, spawnProcess = spawn } = {}) {
  if (typeof file !== "string" || !path.isAbsolute(file) || file.includes("\0") || /[\r\n"]/u.test(file)) {
    return Promise.resolve(false);
  }
  const [command, args] = platform === "win32"
    ? ["explorer.exe", [`/select,"${file}"`]]
    : platform === "darwin" ? ["/usr/bin/open", ["-R", file]] : ["xdg-open", [path.dirname(file)]];
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnProcess(command, args, { detached: true, stdio: "ignore", windowsHide: false,
        // explorer.exe parses its own command line: pass /select,"<path>" exactly (quotes are rejected in paths above).
        windowsVerbatimArguments: platform === "win32" });
    } catch { resolve(false); return; }
    child.once("error", () => resolve(false));
    child.once("spawn", () => { child.unref?.(); resolve(true); });
  });
}
