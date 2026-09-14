import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const checkUrl = new URL("../scripts/check-local.ps1", import.meta.url);
const agentsUrl = new URL("../AGENTS.md", import.meta.url);
const readmeUrl = new URL("../README.md", import.meta.url);
const packageUrl = new URL("../package.json", import.meta.url);
const packageLockUrl = new URL("../package-lock.json", import.meta.url);
const taskboardPackageUrl = new URL("../taskboard/package.json", import.meta.url);
const taskboardPackageLockUrl = new URL("../taskboard/package-lock.json", import.meta.url);
const taskboardReadmeUrl = new URL("../taskboard/README.md", import.meta.url);
const taskboardChineseReadmeUrl = new URL("../taskboard/README.zh-CN.md", import.meta.url);
const windowsSourceRunbookUrl = new URL(
  "../docs/windows-source-install-guide.zh-CN.md",
  import.meta.url,
);
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
  assert.match(source, /22\.13/);
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

test("Node 22.13 floor stays aligned across runtime contracts and user-facing docs", async () => {
  const [
    rootPackage,
    rootLock,
    taskboardPackage,
    taskboardLock,
    rootReadme,
    taskboardReadme,
    taskboardChineseReadme,
    windowsSourceRunbook,
    checkSource,
  ] = await Promise.all([
    readFile(packageUrl, "utf8").then(JSON.parse),
    readFile(packageLockUrl, "utf8").then(JSON.parse),
    readFile(taskboardPackageUrl, "utf8").then(JSON.parse),
    readFile(taskboardPackageLockUrl, "utf8").then(JSON.parse),
    readFile(readmeUrl, "utf8"),
    readFile(taskboardReadmeUrl, "utf8"),
    readFile(taskboardChineseReadmeUrl, "utf8"),
    readFile(windowsSourceRunbookUrl, "utf8"),
    readFile(checkUrl, "utf8"),
  ]);

  for (const [label, value] of [
    ["root package", rootPackage.engines?.node],
    ["root lock", rootLock.packages?.[""]?.engines?.node],
    ["Taskboard package", taskboardPackage.engines?.node],
    ["Taskboard lock", taskboardLock.packages?.[""]?.engines?.node],
  ]) {
    assert.equal(value, ">=22.13", `${label} must declare the shared Node floor`);
  }

  for (const [label, source] of [
    ["root README", rootReadme],
    ["Taskboard README", taskboardReadme],
    ["Taskboard Chinese README", taskboardChineseReadme],
    ["Windows source runbook", windowsSourceRunbook],
    ["health check", checkSource],
  ]) {
    assert.match(source, /22\.13/, `${label} must document Node 22.13`);
    assert.doesNotMatch(source, /22\.5/, `${label} must not advertise the obsolete floor`);
  }
  assert.match(
    checkSource,
    /-notmatch '\^v\(\\d\+\)\\\.\(\\d\+\)\\\.\(\\d\+\)\$'/,
    "the health check must reject prerelease or suffixed Node versions",
  );
});

test("check script enforces the stable Node 22.13 boundary before reading local config", async () => {
  const fixtureDirectory = await mkdtemp(join(tmpdir(), "codex-feishu-node-gate-"));
  const powershell = join(
    process.env.SystemRoot ?? "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const baseEnvironment = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => name.toLowerCase() !== "path"),
  );
  const runWithVersion = async (version) => {
    await writeFile(
      join(fixtureDirectory, "node.cmd"),
      `@echo off\r\necho ${version}\r\nexit /b 0\r\n`,
      "utf8",
    );
    return spawnSync(powershell, ["-NoProfile", "-File", windowsPath(checkUrl)], {
      encoding: "utf8",
      env: {
        ...baseEnvironment,
        Path: fixtureDirectory,
        BRIDGE_CONFIG: join(fixtureDirectory, "missing-bridge.json"),
        CODEX_FEISHU_PACKAGES_PATH: join(fixtureDirectory, "missing-packages.json"),
      },
    });
  };

  try {
    const belowFloor = await runWithVersion("v22.12.9");
    assert.notEqual(belowFloor.status, 0);
    assert.match(belowFloor.stderr, /Node\.js >= 22\.13 is required/);

    const prerelease = await runWithVersion("v22.13.0-rc.1");
    assert.notEqual(prerelease.status, 0);
    assert.match(prerelease.stderr, /Could not determine the Node\.js version/);

    const supported = await runWithVersion("v22.13.0");
    assert.notEqual(supported.status, 0);
    assert.match(supported.stderr, /Local config is missing/);
    assert.doesNotMatch(supported.stderr, /Node\.js >= 22\.13|Could not determine/);
  } finally {
    await rm(fixtureDirectory, { recursive: true, force: true });
  }
});

test("Windows source runbook keeps executable inputs and npm installs fail-closed", async () => {
  const source = await readFile(windowsSourceRunbookUrl, "utf8");
  const blockedPatterns = [...source.matchAll(/\$deploymentBlockedPattern = '([^'\r\n]+)'/g)].map(
    ([, pattern]) => new RegExp(pattern, "i"),
  );
  assert.ok(blockedPatterns.length > 0, "runbook must define inherited-environment gates");

  const blockedVariables = [
    "NODE_TLS_REJECT_UNAUTHORIZED",
    "NODE_EXTRA_CA_CERTS",
    "HTTPS_PROXY",
    "HTTP_PROXY",
    "ALL_PROXY",
    "SSL_CERT_FILE",
    "CURL_CA_BUNDLE",
  ];
  for (const pattern of blockedPatterns) {
    for (const variable of blockedVariables) {
      assert.match(variable, pattern, `${variable} must be rejected by every runbook gate`);
    }
    assert.doesNotMatch("CODEX_HOME", pattern, "CODEX_HOME has a separate confirmation flow");
  }

  const phaseA = source.match(/## 2\. 阶段 A：[\s\S]*?(?=\n## 3\. 阶段 B：)/)?.[0] ?? "";
  assert.match(
    phaseA,
    /\$inheritedCodexExecutable = \[Environment\]::GetEnvironmentVariable\('CODEX_EXECUTABLE', 'Process'\)/,
  );
  assert.match(
    phaseA,
    /if \(\$null -ne \$inheritedCodexExecutable\) \{\s*throw '[^']+'\s*\}/,
    "phase A must reject even an empty inherited CODEX_EXECUTABLE",
  );
  assert.doesNotMatch(
    phaseA,
    /Resolve-ExistingLocalFile \$inheritedCodexExecutable|Set-Item[^\r\n]+\$inheritedCodexExecutable/,
    "the rejected inherited executable must never become the confirmed executable",
  );

  const phaseB = source.match(/## 3\. 阶段 B：[\s\S]*?(?=\n## 4\. 阶段 C：)/)?.[0] ?? "";
  assert.match(phaseB, /Name = 'node\.exe'; Expected = \$confirmedNodeExecutable/);
  assert.match(phaseB, /Name = 'npm\.cmd'; Expected = \$confirmedNpmExecutable/);
  assert.match(
    phaseB,
    /\[string\]::Equals\(\$confirmedNodeDirectory, \$confirmedNpmDirectory, \[System\.StringComparison\]::OrdinalIgnoreCase\)/,
  );
  assert.match(
    phaseB,
    /\$confirmedNpmCli = Resolve-ExistingLocalFile \(Join-Path \$confirmedNpmDirectory 'node_modules\\npm\\bin\\npm-cli\.js'\)/,
  );
  assert.match(phaseB, /& \$confirmedNodeExecutable \$confirmedNpmCli --version/);
  assert.doesNotMatch(phaseB, /&\s+\$confirmedNpmExecutable\s+install\b/);
  assert.equal(
    [...phaseB.matchAll(/&\s+\$confirmedNodeExecutable\s+\$confirmedNpmCli\s+ci(?:\s|$)/gm)].length,
    2,
    "both lockfile-backed workspaces must use npm ci",
  );
  const rootInstallIndex = phaseB.indexOf("& $confirmedNodeExecutable $confirmedNpmCli ci");
  const taskboardInstallIndex = phaseB.indexOf(
    "& $confirmedNodeExecutable $confirmedNpmCli ci --prefix taskboard",
  );
  const testCommandIndex = phaseB.indexOf("& $confirmedNodeExecutable $confirmedNpmCli test");
  const statusIndex = phaseB.indexOf(
    "$postInstallStatus = @(& $confirmedGitExecutable status --porcelain=v1 --untracked-files=all)",
  );
  assert.ok(rootInstallIndex >= 0 && rootInstallIndex < taskboardInstallIndex);
  assert.ok(taskboardInstallIndex < testCommandIndex);
  assert.ok(testCommandIndex >= 0, "phase B must run the complete test gate");
  assert.ok(
    testCommandIndex < statusIndex,
    "phase B must inspect the whole worktree after install and test",
  );
  assert.match(phaseB.slice(statusIndex), /\$LASTEXITCODE -ne 0[\s\S]*\$postInstallStatus\.Count -gt 0/);
});

test("Windows source runbook is linked once and documents the legacy first acceptance", async () => {
  const [readme, runbook] = await Promise.all([
    readFile(readmeUrl, "utf8"),
    readFile(windowsSourceRunbookUrl, "utf8"),
  ]);
  assert.equal(
    readme.split("./docs/windows-source-install-guide.zh-CN.md").length - 1,
    1,
    "README must expose one canonical runbook entry",
  );
  assert.match(runbook, /首次无害验收[\s\S]{0,200}legacy `tables`/);
  assert.match(runbook, /不通过 Taskboard UI 新增 Base，也不创建或启用 phased subject/);
  assert.match(runbook, /scripts[\\/]simulate-ready\.ps1/);
});

test("every Windows runbook PowerShell block is closed, guarded when needed, and parseable", async () => {
  const runbook = await readFile(windowsSourceRunbookUrl, "utf8");
  const openers = runbook.match(/^```powershell[ \t]*\r?$/gm) ?? [];
  const powershellBlocks = [
    ...runbook.matchAll(/^```powershell[ \t]*\r?\n([\s\S]*?)^```[ \t]*\r?$/gm),
  ].map(([, block]) => block);
  assert.equal(
    powershellBlocks.length,
    openers.length,
    "every PowerShell opener must have a matching closing fence",
  );
  assert.ok(powershellBlocks.length > 0, "runbook must contain executable PowerShell blocks");
  const controlledInvocation = /(?:&\s+\$(?:confirmedGitExecutable|confirmedNodeExecutable|confirmedNpmExecutable|confirmedCodexExecutable)|\.\\scripts\\(?:start-local|check-local|stop-local|simulate-ready)\.ps1)/;
  const parserDirectory = await mkdtemp(join(tmpdir(), "codex-feishu-runbook-parser-"));
  try {
    for (const [index, block] of powershellBlocks.entries()) {
      if (controlledInvocation.test(block)) {
        assert.match(block, /\$deploymentBlockedPattern = '/, `PowerShell block ${index + 1} needs a gate`);
        assert.match(block, /GetEnvironmentVariables\(/, `PowerShell block ${index + 1} must inspect process variables`);
        assert.match(block, /\$blockedProcessVariables\.Count -gt 0[\s\S]*throw/, `PowerShell block ${index + 1} must fail closed`);
      }
      const filename = join(parserDirectory, `block-${index + 1}.ps1`);
      await writeFile(filename, `\ufeff${block}`, "utf8");
    }
    const escapedDirectory = parserDirectory.replaceAll("'", "''");
    const command = [
      "$failed=$false",
      `Get-ChildItem -LiteralPath '${escapedDirectory}' -Filter '*.ps1' | ForEach-Object {`,
      "$tokens=$null",
      "$errors=$null",
      "[void][System.Management.Automation.Language.Parser]::ParseFile($_.FullName,[ref]$tokens,[ref]$errors)",
      "if($errors.Count){$failed=$true;$errors|ForEach-Object{Write-Error $_}}",
      "}",
      "if($failed){exit 1}",
    ].join(";");
    const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", command], {
      encoding: "utf8",
    });
    assert.equal(
      result.status,
      0,
      `all PowerShell blocks must parse: ${result.stderr || result.stdout}`,
    );
  } finally {
    await rm(parserDirectory, { recursive: true, force: true });
  }
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
