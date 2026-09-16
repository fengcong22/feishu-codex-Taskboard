import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const powershell = join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");

export function quotePowerShell(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

export function runPowerShell(source, options = {}) {
  const result = spawnSync(powershell, [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-EncodedCommand", Buffer.from(source, "utf16le").toString("base64"),
  ], { encoding: "utf8", windowsHide: true, timeout: 30_000, ...options });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result;
}

// This executable accepts only --version. Each copied fixture controls its behavior
// with a sidecar, so tests exercise real process launch/timeout/output handling.
export async function compileCodexFixture(directory) {
  const executable = join(directory, "fixture.exe");
  runPowerShell(`$ErrorActionPreference = 'Stop'
Add-Type -OutputAssembly ${quotePowerShell(executable)} -OutputType ConsoleApplication -TypeDefinition @'
using System;
using System.IO;
using System.Diagnostics;
using System.Reflection;
using System.Threading;
public class CodexDiscoveryFixture {
  public static int Main(string[] args) {
    string self = Assembly.GetExecutingAssembly().Location;
    if (args.Length == 1 && args[0] == "--fixture-child") {
      using (FileStream held = new FileStream(self + ".child-lock", FileMode.Create, FileAccess.ReadWrite, FileShare.None)) {
        File.WriteAllText(self + ".child-ready", "ready");
        Stopwatch clock = Stopwatch.StartNew();
        while (clock.ElapsedMilliseconds < 30000 && !File.Exists(self + ".child-stop")) Thread.Sleep(20);
      }
      return 0;
    }
    File.AppendAllText(self + ".invocations", String.Join(" ", args) + "\\n");
    if (args.Length != 1 || args[0] != "--version") return 88;
    string mode = File.ReadAllText(self + ".mode").Trim();
    if (mode.StartsWith("child-")) {
      ProcessStartInfo child = new ProcessStartInfo(self, "--fixture-child");
      child.UseShellExecute = false;
      child.CreateNoWindow = true;
      Process.Start(child).Dispose();
      Stopwatch clock = Stopwatch.StartNew();
      while (!File.Exists(self + ".child-ready") && clock.ElapsedMilliseconds < 10000) Thread.Sleep(10);
      if (mode == "child-timeout") { Thread.Sleep(30000); return 0; }
      Console.WriteLine(mode == "child-success" ? "codex-cli 0.114.0" : "invalid version");
      return 0;
    }
    if (mode == "timeout") { Thread.Sleep(30000); return 0; }
    if (mode == "nonzero") { Console.WriteLine("codex-cli 9.9.9"); return 7; }
    if (mode == "invalid") { Console.WriteLine("PRIVATE INVALID OUTPUT"); Console.Error.WriteLine("PRIVATE STDERR"); return 0; }
    if (mode == "stderr") { Console.Error.WriteLine("codex-cli 0.114.0"); return 0; }
    if (mode == "flood") { while (true) Console.Write(new String('X', 4096)); }
    if (mode == "stderr-flood") { while (true) Console.Error.Write(new String('X', 4096)); }
    Console.WriteLine(mode);
    return 0;
  }
}
'@`);
  return executable;
}

export async function installCodexFixture(template, path, mode = "codex-cli 0.114.0") {
  await mkdir(dirname(path), { recursive: true });
  await copyFile(template, path);
  await writeFile(`${path}.mode`, mode);
  return path;
}
