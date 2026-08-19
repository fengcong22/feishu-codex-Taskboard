import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import test from "node:test";

const checkUrl = new URL("../scripts/check-local.ps1", import.meta.url);
const agentsUrl = new URL("../AGENTS.md", import.meta.url);
const readmeUrl = new URL("../README.md", import.meta.url);
const taskboardScreenshotUrl = new URL("../docs/assets/taskboard-kanban-demo.jpg", import.meta.url);

function windowsPath(url) {
  return decodeURIComponent(url.pathname).replace(/^\/(?:([A-Za-z]:))/, "$1");
}

test("check script exposes a sanitized, opt-in Feishu health contract", async () => {
  const source = await readFile(checkUrl, "utf8");
  assert.match(source, /\[switch\]\$RequireFeishu/);
  assert.match(source, /22\.5/);
  assert.match(source, /config[\\/]bridge\.local\.json/);
  assert.match(source, /127\.0\.0\.1:47823\/api\/meta/);
  assert.match(source, /127\.0\.0\.1:47824\/health/);
  assert.match(source, /Invoke-RestMethod/);
  assert.match(source, /LASTEXITCODE|exit\s+1/i);
  assert.doesNotMatch(source, /Get-Content[^\r\n]*\.env\.local/i);
  assert.doesNotMatch(source, /FEISHU_APP_SECRET\s*=/i);
});

test("check script parses in Windows PowerShell 5", async () => {
  const filename = windowsPath(checkUrl);
  const command = [
    "$tokens=$null",
    "$errors=$null",
    `[void][System.Management.Automation.Language.Parser]::ParseFile('${filename.replaceAll("'", "''")}',[ref]$tokens,[ref]$errors)`,
    "if($errors.Count){$errors|ForEach-Object{Write-Error $_};exit 1}",
  ].join(";");
  const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", command], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("root AGENTS documents the fixed flow and safe change rules", async () => {
  const source = await readFile(agentsUrl, "utf8");
  assert.match(source, /飞书多维表格.*Bridge.*Taskboard/s);
  assert.match(source, /127\.0\.0\.1/);
  assert.match(source, /项目包别名|alias/i);
  assert.match(source, /幂等|去重|event.?id/i);
  assert.match(source, /凭据|secret|密钥/i);
  assert.match(source, /check-local\.ps1/);
  assert.match(source, /npm test/);
});

test("README points team members to the operating contract", async () => {
  const source = await readFile(readmeUrl, "utf8");
  assert.match(source, /AGENTS\.md/);
  assert.match(source, /check-local\.ps1/);
});

test("README presents the verified bridge capabilities without claiming unsupported features", async () => {
  const source = await readFile(readmeUrl, "utf8");
  assert.match(source, /飞书 Bridge × Codex Taskboard/);
  assert.match(source, /```mermaid/);
  assert.match(source, /飞书多维表格/);
  assert.match(source, /官方 SDK/);
  assert.match(source, /Taskboard/);
  assert.match(source, /当前已支持/);
  assert.match(source, /5 分钟快速体验/);
  assert.match(source, /不会自动启动 Codex/);
  assert.match(source, /不会回写飞书记录/);
  assert.match(source, /不处理真实视频/);
  assert.match(source, /完成本地配置后/);
  assert.match(source, /团队提供的匹配测试配置/);
  assert.match(source, /Taskboard 的手动启动与网页展示属于外部 Taskboard 能力/);
  assert.match(source, /不提供 SDK 断线后的自动重连或退避、定时补偿或高可用保障/);
  assert.doesNotMatch(source, /打开任务后点击“启动 Codex”/);
});

test("README embeds a real Taskboard screenshot labeled as local test data", async () => {
  const [source, screenshot] = await Promise.all([
    readFile(readmeUrl, "utf8"),
    readFile(taskboardScreenshotUrl),
  ]);
  assert.match(source, /docs\/assets\/taskboard-kanban-demo\.jpg/);
  assert.match(source, /本地测试数据/);
  assert.ok(screenshot.length > 50_000, "screenshot should be a substantive JPEG asset");
  assert.deepEqual([...screenshot.subarray(0, 3)], [0xff, 0xd8, 0xff]);
});
