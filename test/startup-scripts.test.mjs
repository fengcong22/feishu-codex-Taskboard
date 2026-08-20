import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";

const files = {
  startBatch: new URL("../启动-Taskboard.bat", import.meta.url),
  checkBatch: new URL("../检查-Taskboard.bat", import.meta.url),
  stopBatch: new URL("../停止-Taskboard.bat", import.meta.url),
  start: new URL("../scripts/start-local.ps1", import.meta.url),
  stop: new URL("../scripts/stop-local.ps1", import.meta.url),
  simulate: new URL("../scripts/simulate-ready.ps1", import.meta.url),
};

test("startup binds both services to loopback and scopes runtime paths", async () => {
  const source = await readFile(files.start, "utf8");
  assert.match(source, /CODEX_TASKBOARD_HOST.*127\.0\.0\.1/);
  assert.match(source, /CODEX_TASKBOARD_PORT.*47823/);
  assert.match(source, /BRIDGE_CONFIG/);
  assert.match(source, /\.runtime/);
  assert.match(source, /taskboard\.pid/);
  assert.match(source, /bridge\.pid/);
  assert.match(source, /detached-launcher\.mjs/);
  assert.match(source, /taskboard\.stdout\.log/);
  assert.match(source, /taskboard\.stderr\.log/);
  assert.match(source, /@openai\\codex-win32-/);
  assert.match(source, /vendor\\x86_64-pc-windows-msvc\\bin\\codex\.exe/);
  assert.match(source, /Get-Command codex\.exe/);
  assert.match(source, /Test-Path -LiteralPath \$candidate/);
  assert.match(source, /CODEX_EXECUTABLE/);
  assert.match(source, /CODEX_FEISHU_PACKAGES_PATH/);
  assert.match(source, /CODEX_FEISHU_PACKAGES_PATH\s*=\s*\$config/);
  assert.match(source, /CODEX_TASKBOARD_ROOT/);
  assert.match(source, /\/health/);
  assert.match(source, /EnableFeishu/);
  assert.match(source, /FEISHU_LISTENER_ENABLED/);
});

test("bridge startup tracks listener mode and only replaces an owned mismatched process", async () => {
  const source = await readFile(files.start, "utf8");
  assert.match(source, /bridge\.feishu-mode/);
  assert.match(source, /RequestedMode/);
  assert.match(source, /taskkill\.exe \/PID/);
  assert.match(source, /bridgeModeFile/);
  assert.match(source, /runtime ownership marker/);
});

test("Feishu-enabled startup waits for SDK-managed readiness and cleans up on failure", async () => {
  const source = await readFile(files.start, "utf8");
  assert.match(source, /Wait-FeishuReady/);
  assert.match(source, /feishuListener/);
  assert.match(source, /sdk_managed/);
  assert.match(source, /AddSeconds\(30\)/);
  assert.match(source, /startedNodes/);
  assert.match(source, /Stop-ValidatedNode/);
});

test("startup tracks the exact PID returned by the detached launcher", async () => {
  const source = await readFile(files.start, "utf8");
  assert.match(source, /launcherOutput/);
  assert.match(source, /launchedPid/);
  assert.match(source, /startedNodes\[\$launchedPid\]/);
  assert.match(source, /ProcessId=\$launchedPid/);
});

test("startup ties readiness checks to the process that owns the service port", async () => {
  const source = await readFile(files.start, "utf8");
  assert.match(source, /Get-NetTCPConnection/);
  assert.match(source, /OwningProcess/);
  assert.match(source, /ExpectedPid/);
  assert.match(source, /47824/);
});

test("startup serializes launches and preserves process identity during cleanup", async () => {
  const source = await readFile(files.start, "utf8");
  assert.match(source, /System\.Threading\.Mutex/);
  assert.match(source, /WaitOne/);
  assert.match(source, /CreationDate/);
  assert.match(source, /StartedAt/);
  assert.match(source, /ReleaseMutex/);
});

test("double-click batch launchers delegate to the repository scripts", async () => {
  const start = await readFile(files.startBatch, "utf8");
  const check = await readFile(files.checkBatch, "utf8");
  const stop = await readFile(files.stopBatch, "utf8");
  assert.match(start, /@echo off/i);
  assert.match(start, /scripts\\start-local\.ps1/i);
  assert.match(start, /-EnableFeishu/i);
  assert.match(start, /%~dp0/i);
  assert.match(check, /scripts\\check-local\.ps1/i);
  assert.match(check, /-RequireFeishu/i);
  assert.match(stop, /scripts\\stop-local\.ps1/i);
  assert.match(check, /\)\s*echo\.\s*pause\s*endlocal/is);
  for (const source of [start, check, stop]) {
    assert.match(source, /powershell\.exe/i);
    assert.match(source, /-NoProfile/i);
  }
});

test("local check keeps the Node validation import quoted for Windows PowerShell", async () => {
  const source = await readFile(new URL("../scripts/check-local.ps1", import.meta.url), "utf8");
  assert.match(source, /from '\.\/src\/config\.mjs'/);
  assert.doesNotMatch(source, /from "\.\/src\/config\.mjs"/);
});

test("stop script stops only validated PIDs from runtime files", async () => {
  const source = await readFile(files.stop, "utf8");
  assert.match(source, /taskboard\.pid/);
  assert.match(source, /bridge\.pid/);
  assert.match(source, /Get-CimInstance Win32_Process/);
  assert.match(source, /CommandLine/);
  assert.match(source, /\$processId/);
  assert.match(source, /taskkill\.exe \/PID \$processId \/T \/F/);
  assert.match(source, /CODEX_TASKBOARD_ROOT/);
  assert.doesNotMatch(source, /\$pid\s*=/i);
  assert.doesNotMatch(source, /Get-Process node\s*\|\s*Stop-Process/i);
});

test("simulation sends a deterministic transition to 待剪辑", async () => {
  const source = await readFile(files.simulate, "utf8");
  assert.match(source, /\\u89c6\\u9891\\u6574\\u4f53\\u8fdb\\u5ea6/);
  assert.match(source, /\\u5f85\\u526a\\u8f91/);
  assert.match(source, /Auto-cut-copyA/);
  assert.match(source, /api\/simulate\/record-changed/);
});

test("Windows PowerShell 5 can parse every PowerShell startup script", () => {
  for (const [name, url] of Object.entries(files)) {
    if (!url.pathname.toLowerCase().endsWith(".ps1")) continue;
    const filename = decodeURIComponent(url.pathname).replace(/^\/(?:([A-Za-z]:))/, "$1");
    const command = [
      "$tokens=$null",
      "$errors=$null",
      `[void][System.Management.Automation.Language.Parser]::ParseFile('${filename.replaceAll("'", "''")}',[ref]$tokens,[ref]$errors)`,
      "if($errors.Count){$errors|ForEach-Object{Write-Error $_};exit 1}",
    ].join(";");
    const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", command], {
      encoding: "utf8",
    });
    assert.equal(result.status, 0, `${name}: ${result.stderr || result.stdout}`);
  }
});
