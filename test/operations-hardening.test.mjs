import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import test from "node:test";

const checkUrl = new URL("../scripts/check-local.ps1", import.meta.url);
const agentsUrl = new URL("../AGENTS.md", import.meta.url);
const readmeUrl = new URL("../README.md", import.meta.url);
const packageUrl = new URL("../package.json", import.meta.url);
const reliabilitySpecUrl = new URL(
  "../docs/superpowers/specs/2026-08-19-feishu-bridge-reliability-compensation-design.md",
  import.meta.url,
);
const autoCutWorkflowSpecUrl = new URL(
  "../docs/superpowers/specs/2026-08-21-feishu-autocut-workflow-design.md",
  import.meta.url,
);
const taskboardScreenshotUrl = new URL("../docs/assets/taskboard-kanban-demo.jpg", import.meta.url);
const rootCheckWorkflowUrl = new URL("../.github/workflows/check.yml", import.meta.url);

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
  assert.match(source, /\$bridge\.feishuListener\.state/);
  assert.match(source, /\$bridge\.queue/);
  assert.match(source, /sdk_managed/);
  assert.match(source, /retryWait/);
  assert.match(source, /deadLetter/);
  assert.match(source, /public socket|socket-confirmed|物理.*连接|socket/i);
  assert.doesNotMatch(source, /lastError\.message/);
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

test("root operating contract distinguishes legacy and phased event lifecycles", async () => {
  const source = await readFile(agentsUrl, "utf8");
  assert.match(source, /旧版.*`tables`|`tables`.*旧版/s);
  assert.match(source, /`待剪辑`/);
  assert.match(source, /`initial`.*`first_review`.*`final_review`/s);
  assert.match(source, /已启用阶段/);
  assert.match(source, /模拟事件.*自动执行资格|自动执行资格.*模拟事件/s);
});

test("root npm test enforces the bundled Taskboard quality gates", async () => {
  const packageJson = JSON.parse(await readFile(packageUrl, "utf8"));
  const command = packageJson.scripts?.test ?? "";
  assert.match(command, /node --test/);
  assert.match(command, /npm --prefix taskboard run typecheck/);
  assert.match(command, /npm --prefix taskboard run build:web/);
  assert.match(command, /npm --prefix taskboard run test:components/);
});

test("root CI installs both workspaces and runs the complete root gate", async () => {
  const source = await readFile(rootCheckWorkflowUrl, "utf8");
  assert.match(source, /runs-on:\s*windows-latest/);
  assert.match(source, /npm ci\s*$/m);
  assert.match(source, /npm ci --prefix taskboard/);
  assert.match(source, /npm test\s*$/m);
});

test("README points team members to the operating contract", async () => {
  const source = await readFile(readmeUrl, "utf8");
  assert.match(source, /AGENTS\.md/);
  assert.match(source, /check-local\.ps1/);
});

test("README documents the authenticated read-only Base preview boundary", async () => {
  const source = await readFile(readmeUrl, "utf8");
  assert.match(source, /POST \/api\/feishu\/base-preview/);
  assert.match(source, /x-feishu-bridge-client: taskboard/);
  assert.match(source, /只读.*metadata|metadata.*只读/i);
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
  assert.match(source, /CODEX_TASKBOARD_ALLOW_AUTOMATIC_EXECUTION/);
  assert.match(source, /活动配置快照.*automatic|automatic.*活动配置快照/s);
  assert.match(source, /可信来源|专用来源/);
  assert.match(source, /项目包.*白名单|白名单.*项目包/s);
  assert.match(source, /Auto-Cut.*Taskboard|Taskboard.*Auto-Cut/s);
  assert.match(source, /模拟事件.*自动执行资格|自动执行资格.*模拟事件/s);
  assert.match(source, /完成本地配置后/);
  assert.match(source, /团队提供的匹配测试配置/);
  assert.match(source, /持久化重试|自动重试/);
  assert.match(source, /死信|dead.?letter/i);
  assert.match(source, /SDK.*自动重连/);
  assert.match(source, /sdk_managed/);
  assert.match(source, /至少一次/);
  assert.match(source, /原生幂等|exactly.?once/i);
  assert.match(source, /符号链接.*硬链接|硬链接.*符号链接/s);
  assert.doesNotMatch(source, /不提供 SDK 断线后的自动重连或退避、定时补偿或高可用保障/);
  assert.doesNotMatch(source, /打开任务后点击“启动 Codex”/);
});

test("reliability contract states the Taskboard idempotency boundary", async () => {
  const [agents, spec] = await Promise.all([
    readFile(agentsUrl, "utf8"),
    readFile(reliabilitySpecUrl, "utf8"),
  ]);
  assert.match(agents, /至少一次/);
  assert.match(agents, /原生幂等|exactly.?once/i);
  assert.match(spec, /至少一次/);
  assert.match(spec, /不宣称绝对 exactly-once/);
});

test("Auto-Cut workflow design records the implemented phased amendment", async () => {
  const source = await readFile(autoCutWorkflowSpecUrl, "utf8");
  assert.match(source, /状态：.*已实现/);
  assert.match(source, /三阶段修订/);
  assert.match(source, /`initial`.*`first_review`.*`final_review`/s);
  assert.match(source, /旧版 `tables`/);
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
