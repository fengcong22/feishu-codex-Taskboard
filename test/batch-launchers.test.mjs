import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const launchers = [
  { batch: "启动-Taskboard.bat", script: "start-local.ps1", enable: true, require: false },
  { batch: "停止-Taskboard.bat", script: "stop-local.ps1", enable: false, require: false },
  { batch: "检查-Taskboard.bat", script: "check-local.ps1", enable: false, require: true },
];

for (const launcher of launchers) {
  test(`${launcher.batch} loads scripts under Restricted and preserves arguments and exit codes`, {
    skip: process.platform !== "win32",
  }, async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-batch-policy-"));
    const project = join(directory, "示例 project");
    try {
      await mkdir(join(project, "scripts"), { recursive: true });
      // Only the harmless fixture scripts are available to the copied real entry point.
      await copyFile(new URL(`../${launcher.batch}`, import.meta.url), join(project, "launch.bat"));
      await writeFile(join(project, "scripts", launcher.script), [
        "param([switch]$EnableFeishu, [switch]$RequireFeishu)",
        "$ErrorActionPreference = 'Stop'",
        "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)",
        "$result = [ordered]@{ loaded = $true; enable = [bool]$EnableFeishu; require = [bool]$RequireFeishu; correctDirectory = ((Get-Location).Path -eq (Split-Path $PSScriptRoot -Parent)) }",
        "Write-Output ('POLICY_FIXTURE:' + ($result | ConvertTo-Json -Compress))",
        "exit ([int]$env:CODEX_BATCH_TEST_EXIT_CODE)",
      ].join("\r\n"), "utf8");

      for (const exitCode of [0, 37]) {
        const result = spawnSync("cmd.exe", ["/d", "/c", "launch.bat"], {
          cwd: project,
          env: {
            ...process.env,
            PSExecutionPolicyPreference: "Restricted",
            CODEX_BATCH_TEST_EXIT_CODE: String(exitCode),
          },
          input: "\r\n",
          encoding: "utf8",
          windowsHide: true,
          timeout: 20_000,
        });
        assert.ifError(result.error);
        assert.equal(result.status, exitCode, result.stderr || result.stdout);
        const report = result.stdout.match(/^POLICY_FIXTURE:(.+)\r?$/m);
        assert.ok(report, result.stderr || result.stdout);
        assert.deepEqual(JSON.parse(report[1]), {
          loaded: true,
          enable: launcher.enable,
          require: launcher.require,
          correctDirectory: true,
        });
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}
