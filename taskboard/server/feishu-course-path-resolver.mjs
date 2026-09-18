import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFileCallback);

function failure(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function driveLetter(rootPath) {
  if (typeof rootPath !== "string" || !/^[A-Za-z]:\\/u.test(rootPath)) {
    throw failure("ROOT_PATH_INVALID", "rootPath must begin with a Windows drive letter");
  }
  return `${rootPath[0].toUpperCase()}:`;
}

function parsedDriveRecord(stdout) {
  let record;
  try { record = JSON.parse(String(stdout ?? "").trim()); } catch {}
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw failure("ROOT_PATH_DRIVE_UNAVAILABLE", "The configured drive could not be inspected");
  }
  return record;
}

/**
 * Read only the Windows logical-drive metadata needed to distinguish local
 * paths from mapped shares. The drive letter is validated before being placed
 * in the fixed PowerShell query, so a configured path cannot inject a command.
 */
export function createWindowsCoursePathResolver({
  platform = process.platform,
  execFile = execFileAsync,
} = {}) {
  async function inspect(rootPath) {
    if (platform !== "win32") {
      throw failure("ROOT_PATH_PLATFORM_UNSUPPORTED", "Course delivery paths require Windows");
    }
    const deviceId = driveLetter(rootPath);
    const script = [
      "$ErrorActionPreference = 'Stop'",
      "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
      `$drive = Get-CimInstance Win32_LogicalDisk -Filter \"DeviceID='${deviceId}'\"`,
      "if ($null -eq $drive) { exit 17 }",
      "$drive | Select-Object DeviceID, DriveType, ProviderName | ConvertTo-Json -Compress",
    ].join("; ");
    let response;
    try {
      response = await execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
        windowsHide: true,
        timeout: 5_000,
        maxBuffer: 16 * 1024,
      });
    } catch {
      throw failure("ROOT_PATH_DRIVE_UNAVAILABLE", "The configured drive could not be inspected");
    }
    const record = parsedDriveRecord(response?.stdout);
    if (String(record.DeviceID ?? "").toUpperCase() !== deviceId) {
      throw failure("ROOT_PATH_DRIVE_UNAVAILABLE", "The configured drive could not be inspected");
    }
    return record;
  }

  return Object.freeze({
    async classifyDrive(rootPath) {
      const record = await inspect(rootPath);
      if (record.DriveType === 3) return "local";
      if (record.DriveType === 4) return "network";
      throw failure("ROOT_PATH_KIND_UNKNOWN", "The configured drive is neither local nor mapped network storage");
    },
    async resolveMappedDrive(rootPath) {
      const record = await inspect(rootPath);
      if (record.DriveType !== 4 || typeof record.ProviderName !== "string") {
        throw failure("NETWORK_ROOT_UNRESOLVED", "The network drive mapping could not be resolved");
      }
      const providerName = record.ProviderName.trim().replaceAll("/", "\\");
      if (!/^\\\\[^\\]+\\[^\\]+(?:\\[^\\]+)*$/u.test(providerName)) {
        throw failure("NETWORK_ROOT_UNRESOLVED", "The network drive mapping could not be resolved");
      }
      return providerName;
    },
  });
}
