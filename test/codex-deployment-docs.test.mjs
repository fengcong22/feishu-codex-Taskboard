import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const runbookUrl = new URL("../docs/windows-source-install-guide.zh-CN.md", import.meta.url);
const windowsOnly = { skip: process.platform !== "win32" };

async function exerciseDocumentedPreflight({ fail = false, unsafeEnvironment = false } = {}) {
  const runbook = await readFile(runbookUrl, "utf8");
  const preflight = runbook.match(/\$desktopPreflightScript = @'[\s\S]*?(?=\n\$runtimeDirectory =)/)?.[0];
  assert.ok(preflight, "the deployment runbook must contain the runnable independent preflight");
  const workspace = await mkdtemp(join(tmpdir(), "codex-desktop-preflight-"));
  const repositoryRoot = join(workspace, "中文 project ' path");
  await mkdir(join(repositoryRoot, "scripts"), { recursive: true });
  const probe = [
    "param([switch]$DependenciesOnly)",
    "$ErrorActionPreference = 'Stop'",
    "if (-not $DependenciesOnly) { throw 'DEPENDENCIES_MODE_REQUIRED' }",
    "if ($PID -eq [int]$env:PREFLIGHT_PARENT_PID) { throw 'FRESH_PROCESS_REQUIRED' }",
    "if ($null -ne [Environment]::GetEnvironmentVariable('CODEX_EXECUTABLE', 'Process')) { throw 'CODEX_OVERRIDE_LEAKED' }",
    "$expectedPath = [Environment]::ExpandEnvironmentVariables((@([Environment]::GetEnvironmentVariable('Path', 'Machine'), [Environment]::GetEnvironmentVariable('Path', 'User')) -join ';'))",
    "if ($env:PATH -cne $expectedPath) { throw 'PERSISTENT_PATH_REQUIRED' }",
    "if ($env:PATH.Contains('deployment-session-only-path')) { throw 'TEMPORARY_PATH_LEAKED' }",
    "if ($env:GIT_CONFIG_NOSYSTEM -or $env:GIT_CONFIG_GLOBAL) { throw 'DEPLOYMENT_GIT_OVERRIDES_LEAKED' }",
    "Set-Content -LiteralPath (Join-Path $PSScriptRoot 'fixture-probed') -Value 'verified'",
    fail ? "throw 'FIXTURE_DEPENDENCY_UNAVAILABLE'" : "Write-Host 'FIXTURE_DEPENDENCIES_VERIFIED'",
  ].join("\n");
  await writeFile(join(repositoryRoot, "scripts", "check-local.ps1"), probe, "utf8");
  const command = [
    "$ErrorActionPreference = 'Stop'",
    `$repositoryRoot = '${repositoryRoot.replaceAll("'", "''")}'`,
    "$env:PREFLIGHT_PARENT_PID = [string]$PID",
    "$env:PATH = 'deployment-session-only-path;' + $env:PATH",
    "$env:GIT_CONFIG_NOSYSTEM = '1'",
    "$env:GIT_CONFIG_GLOBAL = 'test-only-config'",
    preflight,
    "if ($env:GIT_CONFIG_NOSYSTEM -ne '1' -or $env:GIT_CONFIG_GLOBAL -ne 'test-only-config') { throw 'PARENT_ENVIRONMENT_CHANGED' }",
    "if (-not $env:PATH.StartsWith('deployment-session-only-path;')) { throw 'PARENT_PATH_CHANGED' }",
    "Write-Host 'FIXTURE_PARENT_ENVIRONMENT_PRESERVED'",
  ].join("\n");
  const blocked = /^(?:ALL_PROXY|CURL_CA_BUNDLE|HTTPS?_PROXY|SSL_CERT_FILE|BRIDGE_(?:ENV_FILE|CONFIG|WORKFLOW_CONFIG)|CODEX_EXECUTABLE|CODEX_FEISHU_(?:PACKAGES_PATH|BRIDGE_URL|BRIDGE_SECRET)|CODEX_TASKBOARD_.+|FEISHU_(?:APP_ID|APP_SECRET|LISTENER_ENABLED|READ_ENABLED)|GIT_.+|NODE_(?:OPTIONS|PATH|TLS_REJECT_UNAUTHORIZED|EXTRA_CA_CERTS)|NPM_CONFIG_.+)$/i;
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !blocked.test(key)));
  if (unsafeEnvironment) env.NODE_OPTIONS = "--no-warnings";
  try {
    const result = spawnSync("powershell.exe", [
      "-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-EncodedCommand",
      Buffer.from(command, "utf16le").toString("base64"),
    ], { encoding: "utf8", env, timeout: 70_000 });
    result.probed = await readFile(join(repositoryRoot, "scripts", "fixture-probed"), "utf8").then(() => true, () => false);
    return result;
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

test("documented deployment preflight uses a fresh desktop environment and preserves its parent", windowsOnly, async () => {
  const result = await exerciseDocumentedPreflight();
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.probed, true, "the child must actually check the fixture dependencies");
  assert.match(result.stdout, /DESKTOP_DEPENDENCIES_OK/);
  assert.match(result.stdout, /FIXTURE_PARENT_ENVIRONMENT_PRESERVED/);
});

test("documented deployment preflight blocks completion when dependencies fail", windowsOnly, async () => {
  const result = await exerciseDocumentedPreflight({ fail: true });
  assert.notEqual(result.status, 0);
  assert.equal(result.probed, true, "the failure must come from the fixture dependency check");
  assert.match(result.stderr, /DESKTOP_DEPENDENCIES_FAILED/);
  assert.doesNotMatch(result.stdout, /DESKTOP_DEPENDENCIES_OK/);
});

test("documented deployment preflight keeps unsafe inherited inputs fail-closed", windowsOnly, async () => {
  const result = await exerciseDocumentedPreflight({ unsafeEnvironment: true });
  assert.notEqual(result.status, 0);
  assert.equal(result.probed, false, "unsafe environment must block the dependency check itself");
  assert.match(result.stderr, /DESKTOP_DEPENDENCIES_FAILED/);
  assert.doesNotMatch(result.stdout, /FIXTURE_DEPENDENCIES_VERIFIED|DESKTOP_DEPENDENCIES_OK/);
});
