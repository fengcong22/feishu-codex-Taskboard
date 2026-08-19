import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";

const files = {
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

test("bridge startup tracks listener mode and replaces a mismatched process", async () => {
  const source = await readFile(files.start, "utf8");
  assert.match(source, /bridge\.feishu-mode/);
  assert.match(source, /RequestedMode/);
  assert.match(source, /taskkill\.exe \/PID/);
  assert.match(source, /bridgeModeFile/);
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

test("Windows PowerShell 5 can parse every startup script", () => {
  for (const [name, url] of Object.entries(files)) {
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
