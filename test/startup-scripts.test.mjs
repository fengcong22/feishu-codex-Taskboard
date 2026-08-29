import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const files = {
  startBatch: new URL("../启动-Taskboard.bat", import.meta.url),
  checkBatch: new URL("../检查-Taskboard.bat", import.meta.url),
  stopBatch: new URL("../停止-Taskboard.bat", import.meta.url),
  start: new URL("../scripts/start-local.ps1", import.meta.url),
  stop: new URL("../scripts/stop-local.ps1", import.meta.url),
  processIdentity: new URL("../scripts/process-identity.ps1", import.meta.url),
  simulate: new URL("../scripts/simulate-ready.ps1", import.meta.url),
};

function powershellLiteral(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

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
  assert.match(source, /CODEX_FEISHU_PACKAGES_PATH\s*=\s*\$packageRegistry/);
  assert.match(source, /packageRegistry/);
  assert.match(source, /autocut-packages\.example\.json/);
  assert.match(source, /CODEX_FEISHU_BRIDGE_SECRET/);
  assert.match(source, /New-Guid/);
  assert.match(source, /CODEX_TASKBOARD_ROOT/);
  assert.match(source, /\[string\]\$TaskboardRoot/);
  assert.match(source, /worktrees\\dashi-taskboard-autocut-workflow/);
  assert.match(source, /Resolve-TaskboardRoot/);
  assert.match(source, /dist\\web\\index\.html/);
  assert.match(source, /\/health/);
  assert.match(source, /EnableFeishu/);
  assert.match(source, /FEISHU_LISTENER_ENABLED/);
});

test("startup resolves an explicit complete Taskboard root before the environment override", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-taskboard-root-resolution-"));
  const explicitRoot = join(directory, "explicit");
  const environmentRoot = join(directory, "environment");
  const helper = fileURLToPath(files.start);
  try {
    await Promise.all([
      mkdir(join(explicitRoot, "server"), { recursive: true }),
      mkdir(join(explicitRoot, "dist", "web"), { recursive: true }),
      mkdir(join(environmentRoot, "server"), { recursive: true }),
      mkdir(join(environmentRoot, "dist", "web"), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(explicitRoot, "server", "index.mjs"), "", "utf8"),
      writeFile(join(explicitRoot, "dist", "web", "index.html"), "", "utf8"),
      writeFile(join(environmentRoot, "server", "index.mjs"), "", "utf8"),
      writeFile(join(environmentRoot, "dist", "web", "index.html"), "", "utf8"),
    ]);
    const command = [
      `$env:CODEX_TASKBOARD_ROOT = ${powershellLiteral(environmentRoot)}`,
      `$source = Get-Content -LiteralPath ${powershellLiteral(helper)} -Raw`,
      "$tokens = $null",
      "$errors = $null",
      "$ast = [System.Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$errors)",
      "$definition = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Resolve-TaskboardRoot' }, $true)",
      "if (-not $definition) { throw 'Resolve-TaskboardRoot is missing' }",
      "Invoke-Expression $definition.Extent.Text",
      `if ((Resolve-TaskboardRoot ${powershellLiteral(explicitRoot)}) -ne ${powershellLiteral(explicitRoot)}) { throw 'explicit Taskboard root did not win' }`,
      `if ((Resolve-TaskboardRoot $null) -ne ${powershellLiteral(environmentRoot)}) { throw 'environment Taskboard root was not used' }`,
    ].join(";");
    const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", command], {
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("startup rejects a Taskboard root without server and built web entrypoints", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-taskboard-root-invalid-"));
  const helper = fileURLToPath(files.start);
  try {
    const command = [
      `$source = Get-Content -LiteralPath ${powershellLiteral(helper)} -Raw`,
      "$tokens = $null",
      "$errors = $null",
      "$ast = [System.Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$errors)",
      "$definition = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Resolve-TaskboardRoot' }, $true)",
      "Invoke-Expression $definition.Extent.Text",
      `$result = try { Resolve-TaskboardRoot ${powershellLiteral(directory)}; 'accepted' } catch { $_.ToString() }`,
      "if ($result -eq 'accepted' -or $result -notmatch 'Taskboard root is incomplete') { throw \"unexpected root validation result: $result\" }",
    ].join(";");
    const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", command], {
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("startup prefers the first complete default Taskboard candidate and falls back safely", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-taskboard-default-candidates-"));
  const preferredRoot = join(directory, "preferred");
  const fallbackRoot = join(directory, "fallback");
  const incompleteRoot = join(directory, "incomplete");
  const helper = fileURLToPath(files.start);
  try {
    await Promise.all([
      mkdir(join(preferredRoot, "server"), { recursive: true }),
      mkdir(join(preferredRoot, "dist", "web"), { recursive: true }),
      mkdir(join(fallbackRoot, "server"), { recursive: true }),
      mkdir(join(fallbackRoot, "dist", "web"), { recursive: true }),
      mkdir(join(incompleteRoot, "server"), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(preferredRoot, "server", "index.mjs"), "", "utf8"),
      writeFile(join(preferredRoot, "dist", "web", "index.html"), "", "utf8"),
      writeFile(join(fallbackRoot, "server", "index.mjs"), "", "utf8"),
      writeFile(join(fallbackRoot, "dist", "web", "index.html"), "", "utf8"),
      writeFile(join(incompleteRoot, "server", "index.mjs"), "", "utf8"),
    ]);
    const command = [
      "$env:CODEX_TASKBOARD_ROOT = $null",
      `$source = Get-Content -LiteralPath ${powershellLiteral(helper)} -Raw`,
      "$tokens = $null",
      "$errors = $null",
      "$ast = [System.Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$errors)",
      "$definition = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Resolve-TaskboardRoot' }, $true)",
      "Invoke-Expression $definition.Extent.Text",
      `if ((Resolve-TaskboardRoot $null @(${powershellLiteral(preferredRoot)}, ${powershellLiteral(fallbackRoot)})) -ne ${powershellLiteral(preferredRoot)}) { throw 'first default candidate was not preferred' }`,
      `if ((Resolve-TaskboardRoot $null @(${powershellLiteral(incompleteRoot)}, ${powershellLiteral(fallbackRoot)})) -ne ${powershellLiteral(fallbackRoot)}) { throw 'incomplete default candidate did not fall back' }`,
    ].join(";");
    const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", command], {
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("bridge startup tracks listener mode and only replaces an owned mismatched process", async () => {
  const source = await readFile(files.start, "utf8");
  assert.match(source, /bridge\.feishu-mode/);
  assert.match(source, /RequestedMode/);
  assert.match(source, /Stop-IdentityVerifiedNodeProcess/);
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
  assert.match(source, /startedNodes\.Add/);
  assert.match(source, /ProcessId=\$launchedPid/);
});

test("startup ties readiness checks to the process that owns the service port", async () => {
  const [start, helper] = await Promise.all([
    readFile(files.start, "utf8"),
    readFile(files.processIdentity, "utf8"),
  ]);
  assert.match(helper, /Get-NetTCPConnection/);
  assert.match(helper, /OwningProcess/);
  assert.match(start, /Test-ListeningPortOwner/);
  assert.match(start, /ExpectedPid/);
  assert.match(start, /47824/);
});

test("startup serializes launches and preserves process identity during cleanup", async () => {
  const source = await readFile(files.start, "utf8");
  assert.match(source, /System\.Threading\.Mutex/);
  assert.match(source, /WaitOne/);
  assert.match(source, /CreationDate/);
  assert.doesNotMatch(source, /StartedAt/);
  assert.match(source, /ReleaseMutex/);
});

test("startup cleanup rejects a replacement PID without captured creation identity", () => {
  const helper = fileURLToPath(files.processIdentity);
  const start = fileURLToPath(files.start);
  const command = [
    `. ${powershellLiteral(helper)}`,
    `$source = Get-Content -LiteralPath ${powershellLiteral(start)} -Raw`,
    "$tokens = $null",
    "$errors = $null",
    "$ast = [System.Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$errors)",
    "$definition = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Test-StartedNodeIdentity' }, $true)",
    "Invoke-Expression $definition.Extent.Text",
    "$created = [DateTime]::SpecifyKind([DateTime]'2026-08-20T00:00:00', [DateTimeKind]::Utc)",
    "$replacement = [pscustomobject]@{ ProcessId = 4242; CreationDate = $created }",
    "$entry = @{ CreationDate = $null; StartedAt = $created.AddMinutes(-1).Ticks }",
    "if (Test-StartedNodeIdentity $replacement $entry) { throw 'replacement PID authorized cleanup' }",
  ].join(";");
  const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", command], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("startup cleanup continues when one stopped process marker cannot be removed", () => {
  const helper = fileURLToPath(files.processIdentity);
  const start = fileURLToPath(files.start);
  const command = [
    "$ErrorActionPreference = 'Stop'",
    `. ${powershellLiteral(helper)}`,
    `$source = Get-Content -LiteralPath ${powershellLiteral(start)} -Raw`,
    "$tokens = $null",
    "$errors = $null",
    "$ast = [System.Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$errors)",
    "foreach ($name in @('Test-StartedNodeIdentity', 'Stop-StartedNodes')) { $definition = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name }, $true); Invoke-Expression $definition.Extent.Text }",
    "$created = [DateTime]::SpecifyKind([DateTime]'2026-08-20T00:00:00', [DateTimeKind]::Utc)",
    "$global:firstProcess = [pscustomobject]@{ ProcessId = 4241; CreationDate = $created }",
    "$global:secondProcess = [pscustomobject]@{ ProcessId = 4242; CreationDate = $created }",
    "$global:startedNodes = @(@{ Pid = 4241; Script = 'first.mjs'; PidFile = 'first.pid'; IdentityFile = 'first.json'; ModeFile = $null; ModeSnapshot = $null; CreationDate = $created.Ticks }, @{ Pid = 4242; Script = 'second.mjs'; PidFile = 'second.pid'; IdentityFile = 'second.json'; ModeFile = $null; ModeSnapshot = $null; CreationDate = $created.Ticks })",
    "function global:Get-CimInstance { [CmdletBinding()] param([Parameter(Position=0)][string]$ClassName, [string]$Filter) if ($Filter -eq 'ProcessId=4241') { return $global:firstProcess }; if ($Filter -eq 'ProcessId=4242') { return $global:secondProcess } }",
    "$global:stoppedPids = @()",
    "function global:Stop-ValidatedNode { param([object]$Process, [string]$Script, [object]$ExpectedIdentity) $global:stoppedPids += [int]$Process.ProcessId }",
    "function global:Remove-StartedMarkers { param([hashtable]$Entry, [object]$ExpectedIdentity) if ($Entry.PidFile -eq 'first.pid') { throw 'simulated marker removal failure' } }",
    "Stop-StartedNodes",
    "if ($global:stoppedPids.Count -ne 2 -or $global:stoppedPids[0] -ne 4241 -or $global:stoppedPids[1] -ne 4242) { throw 'cleanup did not continue to the second process' }",
  ].join(";");
  const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", command], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("startup preserves persisted markers when the PID query fails", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-start-query-error-"));
  const repository = join(directory, "repo");
  const scripts = join(repository, "scripts");
  const runtime = join(repository, ".runtime");
  const startScript = join(scripts, "start-local.ps1");
  const helperScript = join(scripts, "process-identity.ps1");
  const pidFile = join(runtime, "service.pid");
  const identityFile = join(runtime, "service.process.json");
  const fakePid = 2147482991;

  try {
    await Promise.all([
      mkdir(scripts, { recursive: true }),
      mkdir(runtime, { recursive: true }),
    ]);
    await Promise.all([
      copyFile(fileURLToPath(files.start), startScript),
      copyFile(fileURLToPath(files.processIdentity), helperScript),
      writeFile(pidFile, String(fakePid), "utf8"),
      writeFile(
        identityFile,
        JSON.stringify({
          version: 1,
          pid: fakePid,
          creationTicks: "639228193411587320",
        }),
        "utf8",
      ),
    ]);

    const command = [
      "$ErrorActionPreference = 'Stop'",
      `. ${powershellLiteral(helperScript)}`,
      `$source = Get-Content -LiteralPath ${powershellLiteral(startScript)} -Raw`,
      "$tokens = $null",
      "$errors = $null",
      "$ast = [System.Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$errors)",
      "foreach ($name in @('Test-Ready', 'Get-ExpectedListenerState', 'Get-FeishuListenerState', 'Stop-ValidatedNode', 'Set-ProcessMarkers', 'Remove-ProcessMarkerFilesIfUnchanged', 'Remove-StartedMarkers', 'Test-StartedNodeIdentity', 'Start-LocalNode')) { $definition = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name }, $true); Invoke-Expression $definition.Extent.Text }",
    "$global:startedNodes = New-Object System.Collections.ArrayList",
      `$global:launcher = ${powershellLiteral(join(repository, "scripts", "detached-launcher.mjs"))}`,
      "$global:node = 'node.exe'",
      "function global:Get-CimInstance { [CmdletBinding()] param([Parameter(Position=0)][string]$ClassName, [string]$Filter) Write-Error 'simulated CIM query failure' }",
      `try { Start-LocalNode ${powershellLiteral(pidFile)} ${powershellLiteral(identityFile)} 'C:\\service\\index.mjs' 'out.log' 'err.log' @{} $null $null 0 } catch { $global:failure = $_.Exception.Message }`,
      "if ([string]::IsNullOrWhiteSpace($global:failure)) { throw 'startup unexpectedly succeeded' }",
      `if (-not (Test-Path -LiteralPath ${powershellLiteral(pidFile)} -PathType Leaf)) { throw 'PID marker was removed after a CIM query failure' }`,
      `if (-not (Test-Path -LiteralPath ${powershellLiteral(identityFile)} -PathType Leaf)) { throw 'identity marker was removed after a CIM query failure' }`,
    ].join(";");
    const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", command], {
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("persisted process identity rejects PID reuse and malformed markers", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-process-identity-"));
  const identityFile = join(directory, "service.process.json");
  const pidFile = join(directory, "service.pid");
  const helper = fileURLToPath(files.processIdentity);
  const command = [
    `. ${powershellLiteral(helper)}`,
    "$created = [DateTime]::SpecifyKind([DateTime]'2026-08-20T00:00:00', [DateTimeKind]::Utc)",
    "$owned = [pscustomobject]@{ ProcessId = 4242; CreationDate = $created }",
    `Write-PersistedProcessIdentity ${powershellLiteral(identityFile)} $owned`,
    `$saved = Read-PersistedProcessIdentity ${powershellLiteral(identityFile)}`,
    "if ($saved.Version -ne 1) { throw 'identity version was not persisted' }",
    `$document = Get-Content -LiteralPath ${powershellLiteral(identityFile)} -Raw | ConvertFrom-Json`,
    "if ($document.creationTicks -isnot [string]) { throw 'creation ticks must be a decimal string' }",
    "if (-not (Test-PersistedProcessIdentity $owned $saved)) { throw 'exact identity was rejected' }",
    "$reused = [pscustomobject]@{ ProcessId = 4242; CreationDate = $created.AddTicks(1) }",
    "if (Test-PersistedProcessIdentity $reused $saved) { throw 'reused PID was accepted' }",
    "$wrongPid = [pscustomobject]@{ ProcessId = 4243; CreationDate = $created }",
    "if (Test-PersistedProcessIdentity $wrongPid $saved) { throw 'mismatched PID was accepted' }",
    `[System.IO.File]::WriteAllText(${powershellLiteral(identityFile)}, '{not-json')`,
    `if ($null -ne (Read-PersistedProcessIdentity ${powershellLiteral(identityFile)})) { throw 'malformed identity was accepted' }`,
    `[System.IO.File]::WriteAllText(${powershellLiteral(identityFile)}, '{"version":2,"pid":4242,"creationTicks":"638913312000000000"}')`,
    `if ($null -ne (Read-PersistedProcessIdentity ${powershellLiteral(identityFile)})) { throw 'unsupported identity version was accepted' }`,
    `[System.IO.File]::WriteAllText(${powershellLiteral(pidFile)}, '4242')`,
    `if ((Read-PersistedProcessId ${powershellLiteral(pidFile)}) -ne 4242) { throw 'valid PID was rejected' }`,
    `Write-PersistedProcessIdentity ${powershellLiteral(identityFile)} $owned`,
    "$reusedIdentity = New-PersistedProcessIdentity $reused",
    `if (Remove-PersistedProcessMarkersIfMatch ${powershellLiteral(pidFile)} ${powershellLiteral(identityFile)} $reusedIdentity) { throw 'rewritten marker was removed' }`,
    `if (-not (Test-Path -LiteralPath ${powershellLiteral(pidFile)})) { throw 'PID marker disappeared after mismatch' }`,
    `if (-not (Remove-PersistedProcessMarkersIfMatch ${powershellLiteral(pidFile)} ${powershellLiteral(identityFile)} $saved)) { throw 'matching marker was not removed' }`,
    `[System.IO.File]::WriteAllText(${powershellLiteral(pidFile)}, 'not-a-pid')`,
    `if ($null -ne (Read-PersistedProcessId ${powershellLiteral(pidFile)})) { throw 'malformed PID was accepted' }`,
  ].join(";");

  try {
    const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", command], {
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("startup marker cleanup refuses a rewritten sidecar snapshot", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-start-marker-snapshot-"));
  const pidFile = join(directory, "service.pid");
  const identityFile = join(directory, "service.process.json");
  const helper = fileURLToPath(files.processIdentity);
  const start = fileURLToPath(files.start);

  try {
    await Promise.all([
      writeFile(pidFile, "4242", "utf8"),
      writeFile(identityFile, "{\"version\":1,\"pid\":4242,\"creationTicks\":\"639228193411587320\"}", "utf8"),
    ]);
    const command = [
      `. ${powershellLiteral(helper)}`,
      `$source = Get-Content -LiteralPath ${powershellLiteral(start)} -Raw`,
      "$tokens = $null",
      "$errors = $null",
      "$ast = [System.Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$errors)",
      "$definition = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Remove-ProcessMarkerFilesIfUnchanged' }, $true)",
      "if (-not $definition) { throw 'snapshot-gated cleanup helper is missing' }",
      "Invoke-Expression $definition.Extent.Text",
      `$pidSnapshot = Get-ProcessMarkerFileSnapshot ${powershellLiteral(pidFile)}`,
      `$identitySnapshot = Get-ProcessMarkerFileSnapshot ${powershellLiteral(identityFile)}`,
      `[System.IO.File]::WriteAllText(${powershellLiteral(identityFile)}, '{"version":1,"pid":4242,"creationTicks":"639228193411587321"}')`,
      `$removed = Remove-ProcessMarkerFilesIfUnchanged ${powershellLiteral(pidFile)} ${powershellLiteral(identityFile)} $null $pidSnapshot $identitySnapshot $null`,
      "if ($removed) { throw 'rewritten marker snapshot was removed' }",
      `if (-not (Test-Path -LiteralPath ${powershellLiteral(pidFile)} -PathType Leaf)) { throw 'PID marker was removed after a rewrite' }`,
      `if (-not (Test-Path -LiteralPath ${powershellLiteral(identityFile)} -PathType Leaf)) { throw 'identity marker was removed after a rewrite' }`,
    ].join(";");
    const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", command], {
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("node script matching requires exact parsed Windows argv tokens", () => {
  const helper = fileURLToPath(files.processIdentity);
  const script = "C:\\service\\index.mjs";
  const executable = "C:\\Program Files\\nodejs\\node.exe";
  const validCommand = `"${executable}" "${script}" --health-mode`;
  const injectedCommand = `node.exe -e "${executable}" "${script}"`;
  const suffixedCommand = `"${executable}" "${script}"evil`;
  const wrongExecutableCommand = `"C:\\other\\node.exe" "${script}"`;
  const wrongInstallation = "C:\\evil\\node.exe";
  const command = [
    "$ErrorActionPreference = 'Stop'",
    `. ${powershellLiteral(helper)}`,
    `$valid = [pscustomobject]@{ ExecutablePath = ${powershellLiteral(executable)}; CommandLine = ${powershellLiteral(validCommand)} }`,
    `$injected = [pscustomobject]@{ ExecutablePath = ${powershellLiteral(executable)}; CommandLine = ${powershellLiteral(injectedCommand)} }`,
    `$suffixed = [pscustomobject]@{ ExecutablePath = ${powershellLiteral(executable)}; CommandLine = ${powershellLiteral(suffixedCommand)} }`,
    `$wrongExecutable = [pscustomobject]@{ ExecutablePath = ${powershellLiteral(executable)}; CommandLine = ${powershellLiteral(wrongExecutableCommand)} }`,
    `$wrongInstallation = [pscustomobject]@{ ExecutablePath = ${powershellLiteral(wrongInstallation)}; CommandLine = ${powershellLiteral(`"${wrongInstallation}" "${script}"`)} }`,
    `if (-not (Test-NodeScriptProcess $valid ${powershellLiteral(script)})) { throw 'valid argv was rejected' }`,
    `if (Test-NodeScriptProcess $injected ${powershellLiteral(script)}) { throw 'injected argv was accepted' }`,
    `if (Test-NodeScriptProcess $suffixed ${powershellLiteral(script)}) { throw 'suffixed script token was accepted' }`,
    `if (Test-NodeScriptProcess $wrongExecutable ${powershellLiteral(script)}) { throw 'wrong argv zero was accepted' }`,
    `if (Test-NodeScriptProcess $wrongInstallation ${powershellLiteral(script)} ${powershellLiteral(executable)}) { throw 'wrong Node installation was accepted' }`,
  ].join(";");
  const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", command], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("identity-bound stop holds the verified native process handle through taskkill", () => {
  const helper = fileURLToPath(files.processIdentity);
  const script = "C:\\service\\index.mjs";
  const executable = "C:\\Program Files\\nodejs\\node.exe";
  const commandLine = `"${executable}" "${script}"`;
  const command = [
    "$ErrorActionPreference = 'Stop'",
    `. ${powershellLiteral(helper)}`,
    "$self = Get-CimInstance Win32_Process -Filter \"ProcessId=$PID\" -ErrorAction Stop",
    "$selfIdentity = New-PersistedProcessIdentity $self",
    "$realHandle = Open-ProcessIdentityHandle $selfIdentity",
    "if (-not $realHandle) { throw 'could not open an identity-bound handle for the test process' }",
    "try { if (-not (Test-ProcessIdentityHandleActive $realHandle)) { throw 'new handle was not active' }; if ([long]$realHandle.CreationTicks -ne [long]$selfIdentity.CreationTicks) { throw 'native creation time did not match CIM' } } finally { Close-ProcessIdentityHandle $realHandle }",
    "if ($realHandle.Handle -ne [IntPtr]::Zero) { throw 'native handle was not closed' }",
    "$created = [DateTime]::SpecifyKind([DateTime]'2026-08-20T00:00:00', [DateTimeKind]::Utc)",
    `$global:fakeProcess = [pscustomobject]@{ ProcessId = 4242; CreationDate = $created; ExecutablePath = ${powershellLiteral(executable)}; CommandLine = ${powershellLiteral(commandLine)} }`,
    "$fakeIdentity = New-PersistedProcessIdentity $global:fakeProcess",
    "$global:handleOpen = $false",
    "function global:Open-ProcessIdentityHandle { param([object]$ExpectedIdentity) $global:handleOpen = $true; [pscustomobject]@{ Handle = [IntPtr]1; Pid = $ExpectedIdentity.Pid; CreationTicks = $ExpectedIdentity.CreationTicks } }",
    "function global:Close-ProcessIdentityHandle { param([object]$ProcessHandle) $global:handleOpen = $false; $ProcessHandle.Handle = [IntPtr]::Zero }",
    "function global:Test-ProcessIdentityHandleActive { param([object]$ProcessHandle) return $global:handleOpen }",
    "function global:Get-CimInstance { [CmdletBinding()] param([Parameter(Position=0)][string]$ClassName, [string]$Filter) $global:fakeProcess }",
    "function global:Stop-ProcessIdentityHandle { param([object]$ProcessHandle) if (-not $global:handleOpen) { throw 'termination ran without the verified handle' }; $global:handleOpen = $false; return $true }",
    `$stopped = Stop-IdentityVerifiedNodeProcess $global:fakeProcess ${powershellLiteral(script)} $fakeIdentity`,
    "if (-not $stopped) { throw 'verified process was not stopped' }",
    "if ($global:handleOpen) { throw 'verified handle leaked after taskkill' }",
  ].join(";");
  const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", command], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("identity-bound stop refuses to clean markers when termination cannot be confirmed", () => {
  const helper = fileURLToPath(files.processIdentity);
  const script = "C:\\service\\index.mjs";
  const executable = "C:\\Program Files\\nodejs\\node.exe";
  const commandLine = `"${executable}" "${script}"`;
  const command = [
    "$ErrorActionPreference = 'Stop'",
    `. ${powershellLiteral(helper)}`,
    "$created = [DateTime]::SpecifyKind([DateTime]'2026-08-20T00:00:00', [DateTimeKind]::Utc)",
    `$global:fakeProcess = [pscustomobject]@{ ProcessId = 4242; CreationDate = $created; ExecutablePath = ${powershellLiteral(executable)}; CommandLine = ${powershellLiteral(commandLine)} }`,
    "$fakeIdentity = New-PersistedProcessIdentity $global:fakeProcess",
    "function global:Open-ProcessIdentityHandle { param([object]$ExpectedIdentity) [pscustomobject]@{ Handle = [IntPtr]1; Pid = $ExpectedIdentity.Pid; CreationTicks = $ExpectedIdentity.CreationTicks } }",
    "function global:Close-ProcessIdentityHandle { param([object]$ProcessHandle) }",
    "$global:activeChecks = 0",
    "function global:Test-ProcessIdentityHandleActive { param([object]$ProcessHandle) $global:activeChecks++; return $global:activeChecks -eq 1 }",
    "function global:Stop-ProcessIdentityHandle { param([object]$ProcessHandle) return $false }",
    "function global:Get-CimInstance { [CmdletBinding()] param([Parameter(Position=0)][string]$ClassName, [string]$Filter) $global:fakeProcess }",
    "$global:failure = $null",
    "try { Stop-IdentityVerifiedNodeProcess $global:fakeProcess ${powershellLiteral(script)} $fakeIdentity ${powershellLiteral(executable)}; $global:failure = 'termination was treated as confirmed' } catch { $global:failure = $_.Exception.Message }",
    "if ([string]::IsNullOrWhiteSpace($global:failure) -or $global:failure -eq 'termination was treated as confirmed') { throw 'termination failure was not fail-closed' }",
    "$null = $true",
  ].join(";");
  const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", command], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, JSON.stringify({ status: result.status, stdout: result.stdout, stderr: result.stderr }));
});

test("port ownership accepts only the IPv4 loopback listener", () => {
  const helper = fileURLToPath(files.processIdentity);
  const command = [
    `. ${powershellLiteral(helper)}`,
    "function global:Get-NetTCPConnection { [CmdletBinding()] param([int]$LocalPort, [string]$State) [pscustomobject]@{ LocalAddress = '0.0.0.0'; OwningProcess = 4242 } }",
    "if (Test-ListeningPortOwner 47823 4242) { throw 'wildcard listener was accepted' }",
    "function global:Get-NetTCPConnection { [CmdletBinding()] param([int]$LocalPort, [string]$State) [pscustomobject]@{ LocalAddress = '127.0.0.1'; OwningProcess = 4242 } }",
    "if (-not (Test-ListeningPortOwner 47823 4242)) { throw 'loopback listener was rejected' }",
    "function global:Get-NetTCPConnection { [CmdletBinding()] param([int]$LocalPort, [string]$State) @([pscustomobject]@{ LocalAddress = '127.0.0.1'; OwningProcess = 4242 }, [pscustomobject]@{ LocalAddress = '0.0.0.0'; OwningProcess = 4242 }) }",
    "if (Test-ListeningPortOwner 47823 4242) { throw 'mixed loopback and wildcard listeners were accepted' }",
    "function global:Get-NetTCPConnection { [CmdletBinding()] param([int]$LocalPort, [string]$State) @([pscustomobject]@{ LocalAddress = '127.0.0.1'; OwningProcess = 4242 }, [pscustomobject]@{ LocalAddress = '0.0.0.0'; OwningProcess = 4243 }) }",
    "if (Test-ListeningPortOwner 47823 4242) { throw 'cross-owner wildcard listener was accepted' }",
    "function global:Get-NetTCPConnection { [CmdletBinding()] param([int]$LocalPort, [string]$State) [pscustomobject]@{ LocalAddress = '::1'; OwningProcess = 4242 } }",
    "if (Test-ListeningPortOwner 47823 4242) { throw 'IPv6 listener was accepted' }",
    "function global:Get-NetTCPConnection { throw 'force netstat fallback' }",
    "function global:netstat.exe { '  TCP    0.0.0.0:47823    0.0.0.0:0    LISTENING    4242' }",
    "if (Test-ListeningPortOwner 47823 4242) { throw 'netstat wildcard listener was accepted' }",
    "function global:netstat.exe { '  TCP    127.0.0.1:47823    0.0.0.0:0    LISTENING    4242' }",
    "if (-not (Test-ListeningPortOwner 47823 4242)) { throw 'netstat loopback listener was rejected' }",
    "function global:netstat.exe { @('  TCP    127.0.0.1:47823    0.0.0.0:0    LISTENING    4242', '  TCP    0.0.0.0:47823    0.0.0.0:0    LISTENING    4242') }",
    "if (Test-ListeningPortOwner 47823 4242) { throw 'netstat mixed listeners were accepted' }",
    "function global:netstat.exe { @('  TCP    127.0.0.1:47823    0.0.0.0:0    LISTENING    4242', '  TCP    0.0.0.0:47823    0.0.0.0:0    LISTENING    4243') }",
    "if (Test-ListeningPortOwner 47823 4242) { throw 'netstat cross-owner wildcard listener was accepted' }",
    "function global:netstat.exe { '  TCP    [::1]:47823    [::]:0    LISTENING    4242' }",
    "if (Test-ListeningPortOwner 47823 4242) { throw 'netstat IPv6 listener was accepted' }",
  ].join(";");
  const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", command], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("process adoption rechecks the same instance after health validation", async () => {
  const [start, helper] = await Promise.all([
    readFile(files.start, "utf8"),
    Promise.resolve(fileURLToPath(files.processIdentity)),
  ]);
  const script = "C:\\service\\index.mjs";
  const executable = "C:\\Program Files\\nodejs\\node.exe";
  const commandLine = `"${executable}" "${script}"`;
  const command = [
    `. ${powershellLiteral(helper)}`,
    "$created = [DateTime]::SpecifyKind([DateTime]'2026-08-20T00:00:00', [DateTimeKind]::Utc)",
    `$observed = [pscustomobject]@{ ProcessId = 4242; CreationDate = $created; ExecutablePath = ${powershellLiteral(executable)}; CommandLine = ${powershellLiteral(commandLine)} }`,
    `$replacement = [pscustomobject]@{ ProcessId = 4242; CreationDate = $created.AddTicks(1); ExecutablePath = ${powershellLiteral(executable)}; CommandLine = ${powershellLiteral(commandLine)} }`,
    "$global:currentProcess = $replacement",
    "function global:Get-CimInstance { [CmdletBinding()] param([Parameter(Position=0)][string]$ClassName, [string]$Filter) $global:currentProcess }",
    "function global:Test-ListeningPortOwner { param([int]$Port, [int]$ProcessId) return $true }",
    `if ($null -ne (Get-VerifiedCurrentNodeProcess $observed ${powershellLiteral(script)} 47823)) { throw 'replacement process was adopted' }`,
    "$global:currentProcess = $observed",
    `$verified = Get-VerifiedCurrentNodeProcess $observed ${powershellLiteral(script)} 47823`,
    "if ($null -eq $verified) { throw 'unchanged process was rejected' }",
  ].join(";");
  const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", command], {
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.doesNotMatch(start, /Set-ProcessMarkers \$PidFile \$IdentityFile \$(?:old|existing)/);
  assert.ok(
    [...start.matchAll(/Get-VerifiedCurrentNodeProcess/g)].length >= 4,
    "every legacy and unmarked adoption path must re-query the process",
  );
});

test("startup readiness rejects PID reuse after persisted identity capture", () => {
  const helper = fileURLToPath(files.processIdentity);
  const start = fileURLToPath(files.start);
  const script = "C:\\service\\index.mjs";
  const executable = "C:\\Program Files\\nodejs\\node.exe";
  const commandLine = `"${executable}" "${script}"`;
  const command = [
    `. ${powershellLiteral(helper)}`,
    `$source = Get-Content -LiteralPath ${powershellLiteral(start)} -Raw`,
    "$tokens = $null",
    "$errors = $null",
    "$ast = [System.Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$errors)",
    "foreach ($name in @('Test-Ready')) { $definition = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name }, $true); Invoke-Expression $definition.Extent.Text }",
    "$created = [DateTime]::SpecifyKind([DateTime]'2026-08-20T00:00:00', [DateTimeKind]::Utc)",
    `$global:observed = [pscustomobject]@{ ProcessId = 4242; CreationDate = $created; ExecutablePath = ${powershellLiteral(executable)}; CommandLine = ${powershellLiteral(commandLine)} }`,
    `$global:replacement = [pscustomobject]@{ ProcessId = 4242; CreationDate = $created.AddTicks(1); ExecutablePath = ${powershellLiteral(executable)}; CommandLine = ${powershellLiteral(commandLine)} }`,
    "$global:current = $global:replacement",
    "function global:Get-CimInstance { [CmdletBinding()] param([Parameter(Position=0)][string]$ClassName, [string]$Filter) $global:current }",
    "function global:Test-ListeningPortOwner { param([int]$Port, [int]$ProcessId) return $true }",
    "function global:Invoke-WebRequest { [pscustomobject]@{ StatusCode = 200 } }",
    "$expected = New-PersistedProcessIdentity $global:observed",
    `if (Test-Ready 'http://127.0.0.1:47823/api/meta' 4242 47823 ${powershellLiteral(script)} ${powershellLiteral(executable)} $expected) { throw 'replacement PID passed readiness' }`,
    "$global:current = $global:observed",
    `if (-not (Test-Ready 'http://127.0.0.1:47823/api/meta' 4242 47823 ${powershellLiteral(script)} ${powershellLiteral(executable)} $expected)) { throw 'unchanged process failed readiness' }`,
  ].join(";");
  const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", command], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("startup readiness rechecks process identity after the health response", () => {
  const helper = fileURLToPath(files.processIdentity);
  const start = fileURLToPath(files.start);
  const script = "C:\\service\\index.mjs";
  const executable = "C:\\Program Files\\nodejs\\node.exe";
  const commandLine = `"${executable}" "${script}"`;
  const command = [
    `. ${powershellLiteral(helper)}`,
    `$source = Get-Content -LiteralPath ${powershellLiteral(start)} -Raw`,
    "$tokens = $null",
    "$errors = $null",
    "$ast = [System.Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$errors)",
    "$definition = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Test-Ready' }, $true)",
    "Invoke-Expression $definition.Extent.Text",
    "$created = [DateTime]::SpecifyKind([DateTime]'2026-08-20T00:00:00', [DateTimeKind]::Utc)",
    `$global:observed = [pscustomobject]@{ ProcessId = 4242; CreationDate = $created; ExecutablePath = ${powershellLiteral(executable)}; CommandLine = ${powershellLiteral(commandLine)} }`,
    `$global:replacement = [pscustomobject]@{ ProcessId = 4242; CreationDate = $created.AddTicks(1); ExecutablePath = ${powershellLiteral(executable)}; CommandLine = ${powershellLiteral(commandLine)} }`,
    "$global:current = $global:observed",
    "function global:Get-CimInstance { [CmdletBinding()] param([Parameter(Position=0)][string]$ClassName, [string]$Filter) $global:current }",
    "function global:Test-ListeningPortOwner { param([int]$Port, [int]$ProcessId) return $true }",
    "function global:Invoke-WebRequest { $global:current = $global:replacement; [pscustomobject]@{ StatusCode = 200 } }",
    "$expected = New-PersistedProcessIdentity $global:observed",
    `if (Test-Ready 'http://127.0.0.1:47823/api/meta' 4242 47823 ${powershellLiteral(script)} ${powershellLiteral(executable)} $expected) { throw 'replacement process passed post-health readiness' }`,
  ].join(";");
  const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", command], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("legacy marker cleanup preserves a newly written identity sidecar", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-marker-rewrite-"));
  const pidFile = join(directory, "service.pid");
  const identityFile = join(directory, "service.process.json");
  const helper = fileURLToPath(files.processIdentity);
  const stop = fileURLToPath(files.stop);

  try {
    await writeFile(pidFile, "4242", "utf8");
    const command = [
      `. ${powershellLiteral(helper)}`,
      `$source = Get-Content -LiteralPath ${powershellLiteral(stop)} -Raw`,
      "$tokens = $null",
      "$errors = $null",
      "$ast = [System.Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$errors)",
      "foreach ($name in @('Remove-TargetMarkerFiles', 'Remove-TargetMarkersIfUnchanged')) { $definition = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name }, $true); Invoke-Expression $definition.Extent.Text }",
      `$target = @{ File = ${powershellLiteral(pidFile)}; IdentityFile = ${powershellLiteral(identityFile)}; ModeFile = $null }`,
      `$snapshot = Get-ProcessMarkerFileSnapshot ${powershellLiteral(identityFile)}`,
      `[System.IO.File]::WriteAllText(${powershellLiteral(identityFile)}, '{"version":1,"pid":4242,"creationTicks":"638913312000000000"}')`,
      "$removed = Remove-TargetMarkersIfUnchanged $target 4242 -ExpectedIdentitySnapshot $snapshot -AllowInvalidIdentity",
      "if ($removed) { throw 'rewritten identity marker was removed' }",
      `if (-not (Test-Path -LiteralPath ${powershellLiteral(pidFile)})) { throw 'PID marker was removed after identity rewrite' }`,
      `if (-not (Test-Path -LiteralPath ${powershellLiteral(identityFile)})) { throw 'new identity marker was removed' }`,
    ].join(";");
    const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", command], {
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("stop marker cleanup preserves a rewritten mode sidecar", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-mode-marker-rewrite-"));
  const pidFile = join(directory, "service.pid");
  const identityFile = join(directory, "service.process.json");
  const modeFile = join(directory, "service.mode");
  const helper = fileURLToPath(files.processIdentity);
  const stop = fileURLToPath(files.stop);
  const created = "2026-08-20T00:00:00";

  try {
    await Promise.all([
      writeFile(pidFile, "4242", "utf8"),
      writeFile(identityFile, "{\"version\":1,\"pid\":4242,\"creationTicks\":\"639228193411587320\"}", "utf8"),
      writeFile(modeFile, "enabled", "utf8"),
    ]);
    const command = [
      `. ${powershellLiteral(helper)}`,
      `$source = Get-Content -LiteralPath ${powershellLiteral(stop)} -Raw`,
      "$tokens = $null",
      "$errors = $null",
      "$ast = [System.Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$errors)",
      "foreach ($name in @('Remove-TargetMarkerFiles', 'Remove-TargetMarkersIfUnchanged')) { $definition = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name }, $true); Invoke-Expression $definition.Extent.Text }",
      `$target = @{ File = ${powershellLiteral(pidFile)}; IdentityFile = ${powershellLiteral(identityFile)}; ModeFile = ${powershellLiteral(modeFile)} }`,
      `$identity = Read-PersistedProcessIdentity ${powershellLiteral(identityFile)}`,
      `$modeSnapshot = Get-ProcessMarkerFileSnapshot ${powershellLiteral(modeFile)}`,
      `[System.IO.File]::WriteAllText(${powershellLiteral(modeFile)}, 'disabled')`,
      `$removed = Remove-TargetMarkersIfUnchanged $target 4242 $identity $null $modeSnapshot`,
      "if ($removed) { throw 'rewritten mode marker was removed' }",
      `if (-not (Test-Path -LiteralPath ${powershellLiteral(pidFile)} -PathType Leaf)) { throw 'PID marker was removed after mode rewrite' }`,
      `if (-not (Test-Path -LiteralPath ${powershellLiteral(identityFile)} -PathType Leaf)) { throw 'identity marker was removed after mode rewrite' }`,
      `if ((Get-Content -LiteralPath ${powershellLiteral(modeFile)} -Raw).Trim() -ne 'disabled') { throw 'rewritten mode marker changed unexpectedly' }`,
    ].join(";");
    const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", command], {
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("startup failure cleanup preserves a rewritten Bridge mode sidecar", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-start-mode-marker-rewrite-"));
  const pidFile = join(directory, "service.pid");
  const identityFile = join(directory, "service.process.json");
  const modeFile = join(directory, "service.mode");
  const helper = fileURLToPath(files.processIdentity);
  const start = fileURLToPath(files.start);

  try {
    await Promise.all([
      writeFile(pidFile, "4242", "utf8"),
      writeFile(identityFile, "{\"version\":1,\"pid\":4242,\"creationTicks\":\"639228193411587320\"}", "utf8"),
      writeFile(modeFile, "enabled", "utf8"),
    ]);
    const command = [
      `. ${powershellLiteral(helper)}`,
      `$source = Get-Content -LiteralPath ${powershellLiteral(start)} -Raw`,
      "$tokens = $null",
      "$errors = $null",
      "$ast = [System.Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$errors)",
      "$definition = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Remove-StartedMarkers' }, $true)",
      "if (-not $definition) { throw 'startup marker cleanup helper is missing' }",
      "Invoke-Expression $definition.Extent.Text",
      "$created = [DateTime]::SpecifyKind([DateTime]'2026-08-20T00:00:00', [DateTimeKind]::Utc)",
      "$process = [pscustomobject]@{ ProcessId = 4242; CreationDate = $created }",
      `$entry = @{ PidFile = ${powershellLiteral(pidFile)}; IdentityFile = ${powershellLiteral(identityFile)}; ModeFile = ${powershellLiteral(modeFile)}; ModeSnapshot = (Get-ProcessMarkerFileSnapshot ${powershellLiteral(modeFile)}) }`,
      `[System.IO.File]::WriteAllText(${powershellLiteral(modeFile)}, 'disabled')`,
      "$identity = Read-PersistedProcessIdentity $entry.IdentityFile",
      "Remove-StartedMarkers $entry $identity",
      `if (-not (Test-Path -LiteralPath ${powershellLiteral(pidFile)} -PathType Leaf)) { throw 'PID marker was removed after mode rewrite' }`,
      `if (-not (Test-Path -LiteralPath ${powershellLiteral(identityFile)} -PathType Leaf)) { throw 'identity marker was removed after mode rewrite' }`,
      `if (-not (Test-Path -LiteralPath ${powershellLiteral(modeFile)} -PathType Leaf)) { throw 'mode marker was removed after mode rewrite' }`,
      `if ((Get-Content -LiteralPath ${powershellLiteral(modeFile)} -Raw).Trim() -ne 'disabled') { throw 'rewritten mode marker changed unexpectedly' }`,
    ].join(";");
    const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", command], {
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("startup cleanup keeps separate records when two launches reuse a PID", () => {
  const helper = fileURLToPath(files.processIdentity);
  const start = fileURLToPath(files.start);
  const command = [
    `. ${powershellLiteral(helper)}`,
    `$source = Get-Content -LiteralPath ${powershellLiteral(start)} -Raw`,
    "$tokens = $null",
    "$errors = $null",
    "$ast = [System.Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$errors)",
    "foreach ($name in @('Test-StartedNodeIdentity', 'Stop-StartedNodes')) { $definition = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name }, $true); Invoke-Expression $definition.Extent.Text }",
    "$created = [DateTime]::SpecifyKind([DateTime]'2026-08-20T00:00:00', [DateTimeKind]::Utc)",
    "$global:startedNodes = @(@{ Pid = 4242; Script = 'first.mjs'; PidFile = 'first.pid'; IdentityFile = 'first.json'; ModeFile = $null; ModeSnapshot = $null; CreationDate = $created.Ticks }, @{ Pid = 4242; Script = 'second.mjs'; PidFile = 'second.pid'; IdentityFile = 'second.json'; ModeFile = $null; ModeSnapshot = $null; CreationDate = $created.Ticks })",
    "$global:fakeProcess = [pscustomobject]@{ ProcessId = 4242; CreationDate = $created }",
    "function global:Get-ProcessQueryResult { [pscustomobject]@{ Succeeded = $true; Process = $global:fakeProcess; Error = $null } }",
    "$global:stopped = @()",
    "function global:Stop-ValidatedNode { param([object]$Process, [string]$Script, [object]$ExpectedIdentity, [string]$ExpectedExecutable) $global:stopped += $Script }",
    "function global:Remove-StartedMarkers { param([hashtable]$Entry, [object]$ExpectedIdentity) }",
    "Stop-StartedNodes",
    "if ($global:stopped.Count -ne 2 -or $global:stopped[0] -ne 'first.mjs' -or $global:stopped[1] -ne 'second.mjs') { throw 'PID reuse collapsed startup cleanup records' }",
  ].join(";");
  const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", command], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("start and stop scripts gate persisted-marker termination on creation identity", async () => {
  const [start, stop, helper] = await Promise.all([
    readFile(files.start, "utf8"),
    readFile(files.stop, "utf8"),
    readFile(files.processIdentity, "utf8"),
  ]);

  for (const source of [start, stop]) {
    assert.match(source, /process-identity\.ps1/);
    assert.match(source, /taskboard\.process\.json/);
    assert.match(source, /bridge\.process\.json/);
    assert.match(source, /Read-PersistedProcessIdentity/);
    assert.match(source, /Test-PersistedProcessIdentity/);
  }
  assert.match(start, /Write-PersistedProcessIdentity/);
  assert.match(start, /legacy/i);
  assert.match(start, /leaving it running/i);
  assert.match(stop, /System\.Threading\.Mutex/);
  assert.match(start, /Stop-IdentityVerifiedNodeProcess/);
  assert.match(helper, /Stop-IdentityVerifiedNodeProcess/);

  const killIndex = helper.indexOf("Stop-ProcessIdentityHandle $processHandle");
  const openHandleIndex = helper.lastIndexOf("Open-ProcessIdentityHandle", killIndex);
  const identityGateIndex = helper.lastIndexOf("Test-PersistedProcessIdentity $current", killIndex);
  const closeHandleIndex = helper.indexOf("Close-ProcessIdentityHandle $processHandle", killIndex);
  assert.ok(killIndex > 0, "shared helper must retain the targeted taskkill call");
  assert.ok(openHandleIndex >= 0, "shared helper must open an identity-bound handle before taskkill");
  assert.ok(identityGateIndex >= 0, "shared helper must check creation identity before taskkill");
  assert.ok(closeHandleIndex > killIndex, "shared helper must close the handle after taskkill");
});

test("stop refuses legacy PID-only markers instead of upgrading and terminating them", async () => {
  const stop = await readFile(files.stop, "utf8");
  assert.doesNotMatch(stop, /Try-AdoptLegacyIdentity/);
  assert.match(stop, /legacy PID-only marker/i);
  assert.match(stop, /leaving it running/i);
});

test("stop leaves a legacy PID-only process running in an isolated execution", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-stop-legacy-"));
  const repository = join(directory, "repo");
  const scripts = join(repository, "scripts");
  const runtime = join(repository, ".runtime");
  const taskboard = join(directory, "taskboard");
  const pidFile = join(runtime, "taskboard.pid");
  const stopScript = join(scripts, "stop-local.ps1");
  const fakePid = 2147483000;

  try {
    await Promise.all([
      mkdir(scripts, { recursive: true }),
      mkdir(runtime, { recursive: true }),
      mkdir(join(taskboard, "server"), { recursive: true }),
    ]);
    await Promise.all([
      copyFile(fileURLToPath(files.stop), stopScript),
      copyFile(fileURLToPath(files.processIdentity), join(scripts, "process-identity.ps1")),
      writeFile(pidFile, String(fakePid), "utf8"),
    ]);

    const command = [
      `$env:CODEX_TASKBOARD_ROOT = ${powershellLiteral(taskboard)}`,
      `function global:Get-CimInstance { [CmdletBinding()] param([Parameter(Position=0)][string]$ClassName, [string]$Filter) [pscustomobject]@{ ProcessId = ${fakePid} } }`,
      "function global:taskkill.exe { throw 'taskkill must not run for a legacy marker' }",
      `& ${powershellLiteral(stopScript)}`,
    ].join(";");
    const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", command], {
      encoding: "utf8",
    });
    assert.equal(result.status, 1, result.stderr || result.stdout);
    assert.match(`${result.stdout}\n${result.stderr}`, /legacy PID-only marker/i);
    await assert.rejects(access(pidFile));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("stop preserves a live valid sidecar when its PID marker is missing or malformed", async () => {
  for (const markerValue of [null, "not-a-pid"]) {
    const directory = await mkdtemp(join(tmpdir(), "codex-stop-pid-marker-"));
    const repository = join(directory, "repo");
    const scripts = join(repository, "scripts");
    const runtime = join(repository, ".runtime");
    const taskboard = join(directory, "taskboard");
    const taskboardScript = join(taskboard, "server", "index.mjs");
    const pidFile = join(runtime, "taskboard.pid");
    const identityFile = join(runtime, "taskboard.process.json");
    const stopScript = join(scripts, "stop-local.ps1");
    const helperScript = join(scripts, "process-identity.ps1");
    const fakePid = 2147482996;
    const nodeExecutable = "C:\\Program Files\\nodejs\\node.exe";

    try {
      await Promise.all([
        mkdir(scripts, { recursive: true }),
        mkdir(runtime, { recursive: true }),
        mkdir(join(taskboard, "server"), { recursive: true }),
      ]);
      await Promise.all([
        copyFile(fileURLToPath(files.stop), stopScript),
        copyFile(fileURLToPath(files.processIdentity), helperScript),
      ]);
      if (markerValue !== null) await writeFile(pidFile, markerValue, "utf8");

      const commandLine = `"${nodeExecutable}" "${taskboardScript}"`;
      const command = [
        `$env:CODEX_TASKBOARD_ROOT = ${powershellLiteral(taskboard)}`,
        `. ${powershellLiteral(helperScript)}`,
        "$created = [DateTime]::SpecifyKind([DateTime]'2026-08-20T00:00:00', [DateTimeKind]::Utc)",
        `$global:fakeProcess = [pscustomobject]@{ ProcessId = ${fakePid}; CreationDate = $created; ExecutablePath = ${powershellLiteral(nodeExecutable)}; CommandLine = ${powershellLiteral(commandLine)} }`,
        `Write-PersistedProcessIdentity ${powershellLiteral(identityFile)} $global:fakeProcess`,
        "function global:Get-CimInstance { [CmdletBinding()] param([Parameter(Position=0)][string]$ClassName, [string]$Filter) $global:fakeProcess }",
        "function global:taskkill.exe { throw 'taskkill must not run without both valid markers' }",
        `& ${powershellLiteral(stopScript)}`,
      ].join(";");
      const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", command], {
        encoding: "utf8",
      });

      assert.equal(result.status, 1, result.stderr || result.stdout);
      assert.match(`${result.stdout}\n${result.stderr}`, /PID marker/i);
      await access(identityFile);
      if (markerValue !== null) await access(pidFile);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test("stop refuses a missing PID with a malformed identity sidecar", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-stop-invalid-sidecar-"));
  const repository = join(directory, "repo");
  const scripts = join(repository, "scripts");
  const runtime = join(repository, ".runtime");
  const taskboard = join(directory, "taskboard");
  const identityFile = join(runtime, "bridge.process.json");
  const modeFile = join(runtime, "bridge.feishu-mode");
  const stopScript = join(scripts, "stop-local.ps1");
  const helperScript = join(scripts, "process-identity.ps1");

  try {
    await Promise.all([
      mkdir(scripts, { recursive: true }),
      mkdir(runtime, { recursive: true }),
      mkdir(join(taskboard, "server"), { recursive: true }),
    ]);
    await Promise.all([
      copyFile(fileURLToPath(files.stop), stopScript),
      copyFile(fileURLToPath(files.processIdentity), helperScript),
      writeFile(identityFile, "{not-json", "utf8"),
      writeFile(modeFile, "enabled", "utf8"),
    ]);

    const command = [
      `$env:CODEX_TASKBOARD_ROOT = ${powershellLiteral(taskboard)}`,
      `. ${powershellLiteral(helperScript)}`,
      "function global:Get-CimInstance { throw 'CIM must not run without a valid PID or identity' }",
      "function global:taskkill.exe { throw 'taskkill must not run without a valid PID or identity' }",
      `& ${powershellLiteral(stopScript)}`,
    ].join(";");
    const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", command], {
      encoding: "utf8",
    });

    assert.equal(result.status, 1, result.stderr || result.stdout);
    assert.match(`${result.stdout}\n${result.stderr}`, /identity|marker|标记/i);
    await access(identityFile);
    await access(modeFile);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("stop refuses a non-leaf PID marker path", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-stop-pid-directory-"));
  const repository = join(directory, "repo");
  const scripts = join(repository, "scripts");
  const runtime = join(repository, ".runtime");
  const taskboard = join(directory, "taskboard");
  const pidPath = join(runtime, "bridge.pid");
  const modeFile = join(runtime, "bridge.feishu-mode");
  const stopScript = join(scripts, "stop-local.ps1");
  const helperScript = join(scripts, "process-identity.ps1");

  try {
    await Promise.all([
      mkdir(scripts, { recursive: true }),
      mkdir(runtime, { recursive: true }),
      mkdir(join(taskboard, "server"), { recursive: true }),
      mkdir(pidPath, { recursive: true }),
    ]);
    await Promise.all([
      copyFile(fileURLToPath(files.stop), stopScript),
      copyFile(fileURLToPath(files.processIdentity), helperScript),
      writeFile(modeFile, "enabled", "utf8"),
    ]);

    const command = [
      `$env:CODEX_TASKBOARD_ROOT = ${powershellLiteral(taskboard)}`,
      `. ${powershellLiteral(helperScript)}`,
      `& ${powershellLiteral(stopScript)}`,
    ].join(";");
    const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", command], {
      encoding: "utf8",
    });

    assert.equal(result.status, 1, result.stderr || result.stdout);
    assert.match(`${result.stdout}\n${result.stderr}`, /PID|marker|标记/i);
    await access(pidPath);
    await access(modeFile);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("stop checks the second target after refusing the first live target", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-stop-continue-"));
  const repository = join(directory, "repo");
  const scripts = join(repository, "scripts");
  const runtime = join(repository, ".runtime");
  const taskboard = join(directory, "taskboard");
  const taskboardPid = 2147482998;
  const bridgePid = 2147482997;
  const taskboardPidFile = join(runtime, "taskboard.pid");
  const bridgePidFile = join(runtime, "bridge.pid");
  const bridgeIdentityFile = join(runtime, "bridge.process.json");
  const stopScript = join(scripts, "stop-local.ps1");
  const helperScript = join(scripts, "process-identity.ps1");
  const bridgeScript = join(repository, "src", "index.mjs");
  const killMarker = join(directory, "taskkill-called.txt");
  const nodeExecutable = "C:\\Program Files\\nodejs\\node.exe";

  try {
    const helperSource = await readFile(files.processIdentity, "utf8");
    await Promise.all([
      mkdir(scripts, { recursive: true }),
      mkdir(runtime, { recursive: true }),
      mkdir(join(repository, "src"), { recursive: true }),
      mkdir(join(taskboard, "server"), { recursive: true }),
    ]);
    await Promise.all([
      copyFile(fileURLToPath(files.stop), stopScript),
      writeFile(
        helperScript,
        `${helperSource}\nfunction Stop-IdentityVerifiedNodeProcess([object]$Process, [string]$Script, [object]$ExpectedIdentity) { & taskkill.exe /PID $Process.ProcessId /T /F | Out-Null; if ($LASTEXITCODE -ne 0) { throw 'mock taskkill failed' }; return $true }\n`,
        "utf8",
      ),
      writeFile(taskboardPidFile, String(taskboardPid), "utf8"),
      writeFile(bridgePidFile, String(bridgePid), "utf8"),
    ]);

    const bridgeCommandLine = `"${nodeExecutable}" "${bridgeScript}"`;
    const command = [
      `$env:CODEX_TASKBOARD_ROOT = ${powershellLiteral(taskboard)}`,
      `. ${powershellLiteral(helperScript)}`,
      "$created = [DateTime]::SpecifyKind([DateTime]'2026-08-20T00:00:00', [DateTimeKind]::Utc)",
      `$global:taskboardProcess = [pscustomobject]@{ ProcessId = ${taskboardPid} }`,
      `$global:bridgeProcess = [pscustomobject]@{ ProcessId = ${bridgePid}; CreationDate = $created; ExecutablePath = ${powershellLiteral(nodeExecutable)}; CommandLine = ${powershellLiteral(bridgeCommandLine)} }`,
      `Write-PersistedProcessIdentity ${powershellLiteral(bridgeIdentityFile)} $global:bridgeProcess`,
      `function global:Get-CimInstance { [CmdletBinding()] param([Parameter(Position=0)][string]$ClassName, [string]$Filter) if ($Filter -eq 'ProcessId=${taskboardPid}') { return $global:taskboardProcess }; if ($Filter -eq 'ProcessId=${bridgePid}') { return $global:bridgeProcess } }`,
      `function global:taskkill.exe { param([Parameter(ValueFromRemainingArguments=$true)]$Arguments) [System.IO.File]::WriteAllText(${powershellLiteral(killMarker)}, [string]${bridgePid}); $global:LASTEXITCODE = 0 }`,
      `& ${powershellLiteral(stopScript)}`,
    ].join(";");
    const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", command], {
      encoding: "utf8",
    });

    assert.equal(result.status, 1, result.stderr || result.stdout);
    assert.equal(await readFile(killMarker, "utf8"), String(bridgePid));
    await assert.rejects(access(bridgePidFile));
    await assert.rejects(access(bridgeIdentityFile));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("stop treats a CIM query error as refusal and still stops the second target", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-stop-cim-error-"));
  const repository = join(directory, "repo");
  const scripts = join(repository, "scripts");
  const runtime = join(repository, ".runtime");
  const taskboard = join(directory, "taskboard");
  const taskboardScript = join(taskboard, "server", "index.mjs");
  const bridgeScript = join(repository, "src", "index.mjs");
  const taskboardPid = 2147482995;
  const bridgePid = 2147482994;
  const taskboardPidFile = join(runtime, "taskboard.pid");
  const bridgePidFile = join(runtime, "bridge.pid");
  const taskboardIdentityFile = join(runtime, "taskboard.process.json");
  const bridgeIdentityFile = join(runtime, "bridge.process.json");
  const stopScript = join(scripts, "stop-local.ps1");
  const helperScript = join(scripts, "process-identity.ps1");
  const killMarker = join(directory, "taskkill-called.txt");
  const nodeExecutable = "C:\\Program Files\\nodejs\\node.exe";

  try {
    const helperSource = await readFile(files.processIdentity, "utf8");
    await Promise.all([
      mkdir(scripts, { recursive: true }),
      mkdir(runtime, { recursive: true }),
      mkdir(join(taskboard, "server"), { recursive: true }),
      mkdir(join(repository, "src"), { recursive: true }),
    ]);
    await Promise.all([
      copyFile(fileURLToPath(files.stop), stopScript),
      writeFile(
        helperScript,
        `${helperSource}\nfunction Stop-IdentityVerifiedNodeProcess([object]$Process, [string]$Script, [object]$ExpectedIdentity) { & taskkill.exe /PID $Process.ProcessId /T /F | Out-Null; if ($LASTEXITCODE -ne 0) { throw 'mock taskkill failed' }; return $true }\n`,
        "utf8",
      ),
      writeFile(taskboardPidFile, String(taskboardPid), "utf8"),
      writeFile(bridgePidFile, String(bridgePid), "utf8"),
    ]);

    const taskboardCommandLine = `"${nodeExecutable}" "${taskboardScript}"`;
    const bridgeCommandLine = `"${nodeExecutable}" "${bridgeScript}"`;
    const command = [
      `$env:CODEX_TASKBOARD_ROOT = ${powershellLiteral(taskboard)}`,
      `. ${powershellLiteral(helperScript)}`,
      "$created = [DateTime]::SpecifyKind([DateTime]'2026-08-20T00:00:00', [DateTimeKind]::Utc)",
      `$global:taskboardProcess = [pscustomobject]@{ ProcessId = ${taskboardPid}; CreationDate = $created; ExecutablePath = ${powershellLiteral(nodeExecutable)}; CommandLine = ${powershellLiteral(taskboardCommandLine)} }`,
      `$global:bridgeProcess = [pscustomobject]@{ ProcessId = ${bridgePid}; CreationDate = $created; ExecutablePath = ${powershellLiteral(nodeExecutable)}; CommandLine = ${powershellLiteral(bridgeCommandLine)} }`,
      `Write-PersistedProcessIdentity ${powershellLiteral(taskboardIdentityFile)} $global:taskboardProcess`,
      `Write-PersistedProcessIdentity ${powershellLiteral(bridgeIdentityFile)} $global:bridgeProcess`,
      `function global:Get-CimInstance { [CmdletBinding()] param([Parameter(Position=0)][string]$ClassName, [string]$Filter) if ($Filter -eq 'ProcessId=${taskboardPid}') { throw 'simulated CIM failure' }; if ($Filter -eq 'ProcessId=${bridgePid}') { return $global:bridgeProcess } }`,
      `function global:taskkill.exe { param([Parameter(ValueFromRemainingArguments=$true)]$Arguments) [System.IO.File]::AppendAllText(${powershellLiteral(killMarker)}, ($Arguments -join ' ') + [Environment]::NewLine); $global:LASTEXITCODE = 0 }`,
      `& ${powershellLiteral(stopScript)}`,
    ].join(";");
    const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", command], {
      encoding: "utf8",
    });

    assert.equal(result.status, 1, result.stderr || result.stdout);
    assert.match(`${result.stdout}\n${result.stderr}`, /CIM|query/i);
    const killCalls = await readFile(killMarker, "utf8");
    assert.match(killCalls, new RegExp(String(bridgePid)));
    assert.doesNotMatch(killCalls, new RegExp(String(taskboardPid)));
    await access(taskboardPidFile);
    await access(taskboardIdentityFile);
    await assert.rejects(access(bridgePidFile));
    await assert.rejects(access(bridgeIdentityFile));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("stop continues after marker deletion fails for an already stopped target", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-stop-marker-error-"));
  const repository = join(directory, "repo");
  const scripts = join(repository, "scripts");
  const runtime = join(repository, ".runtime");
  const taskboard = join(directory, "taskboard");
  const taskboardScript = join(taskboard, "server", "index.mjs");
  const bridgeScript = join(repository, "src", "index.mjs");
  const taskboardPid = 2147482993;
  const bridgePid = 2147482992;
  const taskboardPidFile = join(runtime, "taskboard.pid");
  const bridgePidFile = join(runtime, "bridge.pid");
  const taskboardIdentityFile = join(runtime, "taskboard.process.json");
  const bridgeIdentityFile = join(runtime, "bridge.process.json");
  const stopScript = join(scripts, "stop-local.ps1");
  const helperScript = join(scripts, "process-identity.ps1");
  const killMarker = join(directory, "taskkill-called.txt");
  const nodeExecutable = "C:\\Program Files\\nodejs\\node.exe";

  try {
    const helperSource = await readFile(files.processIdentity, "utf8");
    await Promise.all([
      mkdir(scripts, { recursive: true }),
      mkdir(runtime, { recursive: true }),
      mkdir(join(taskboard, "server"), { recursive: true }),
      mkdir(join(repository, "src"), { recursive: true }),
    ]);
    await Promise.all([
      copyFile(fileURLToPath(files.stop), stopScript),
      writeFile(
        helperScript,
        `${helperSource}\nfunction Stop-IdentityVerifiedNodeProcess([object]$Process, [string]$Script, [object]$ExpectedIdentity) { & taskkill.exe /PID $Process.ProcessId /T /F | Out-Null; if ($LASTEXITCODE -ne 0) { throw 'mock taskkill failed' }; return $true }\n`,
        "utf8",
      ),
      writeFile(taskboardPidFile, String(taskboardPid), "utf8"),
      writeFile(bridgePidFile, String(bridgePid), "utf8"),
    ]);

    const taskboardCommandLine = `"${nodeExecutable}" "${taskboardScript}"`;
    const bridgeCommandLine = `"${nodeExecutable}" "${bridgeScript}"`;
    const command = [
      `$env:CODEX_TASKBOARD_ROOT = ${powershellLiteral(taskboard)}`,
      `. ${powershellLiteral(helperScript)}`,
      "$created = [DateTime]::SpecifyKind([DateTime]'2026-08-20T00:00:00', [DateTimeKind]::Utc)",
      `$global:taskboardProcess = [pscustomobject]@{ ProcessId = ${taskboardPid}; CreationDate = $created; ExecutablePath = ${powershellLiteral(nodeExecutable)}; CommandLine = ${powershellLiteral(taskboardCommandLine)} }`,
      `$global:bridgeProcess = [pscustomobject]@{ ProcessId = ${bridgePid}; CreationDate = $created; ExecutablePath = ${powershellLiteral(nodeExecutable)}; CommandLine = ${powershellLiteral(bridgeCommandLine)} }`,
      `Write-PersistedProcessIdentity ${powershellLiteral(taskboardIdentityFile)} $global:taskboardProcess`,
      `Write-PersistedProcessIdentity ${powershellLiteral(bridgeIdentityFile)} $global:bridgeProcess`,
      `function global:Get-CimInstance { [CmdletBinding()] param([Parameter(Position=0)][string]$ClassName, [string]$Filter) if ($Filter -eq 'ProcessId=${taskboardPid}') { return $global:taskboardProcess }; if ($Filter -eq 'ProcessId=${bridgePid}') { return $global:bridgeProcess } }`,
      `function global:taskkill.exe { param([Parameter(ValueFromRemainingArguments=$true)]$Arguments) [System.IO.File]::AppendAllText(${powershellLiteral(killMarker)}, ($Arguments -join ' ') + [Environment]::NewLine); $global:LASTEXITCODE = 0 }`,
      `function global:Remove-Item { [CmdletBinding(SupportsShouldProcess=$true)] param([Parameter(Mandatory=$true)][string[]]$LiteralPath, [switch]$Force) if ($LiteralPath -contains ${powershellLiteral(taskboardPidFile)}) { throw 'simulated marker removal failure' }; & (Get-Command -Name Remove-Item -CommandType Cmdlet) @PSBoundParameters }`,
      `& ${powershellLiteral(stopScript)}`,
    ].join(";");
    const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", command], {
      encoding: "utf8",
    });

    assert.equal(result.status, 1, result.stderr || result.stdout);
    assert.match(`${result.stdout}\n${result.stderr}`, /marker|标记/i);
    const killCalls = await readFile(killMarker, "utf8");
    assert.match(killCalls, new RegExp(String(taskboardPid)));
    assert.match(killCalls, new RegExp(String(bridgePid)));
    await access(taskboardPidFile);
    await access(taskboardIdentityFile);
    await assert.rejects(access(bridgePidFile));
    await assert.rejects(access(bridgeIdentityFile));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("stop terminates only an isolated process with matching persisted identity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-stop-owned-"));
  const repository = join(directory, "repo");
  const scripts = join(repository, "scripts");
  const runtime = join(repository, ".runtime");
  const taskboard = join(directory, "taskboard");
  const taskboardScript = join(taskboard, "server", "index.mjs");
  const pidFile = join(runtime, "taskboard.pid");
  const identityFile = join(runtime, "taskboard.process.json");
  const stopScript = join(scripts, "stop-local.ps1");
  const helperScript = join(scripts, "process-identity.ps1");
  const killMarker = join(directory, "taskkill-called.txt");
  const fakePid = 2147482999;
  const nodeExecutable = "C:\\Program Files\\nodejs\\node.exe";

  try {
    const helperSource = await readFile(files.processIdentity, "utf8");
    await Promise.all([
      mkdir(scripts, { recursive: true }),
      mkdir(runtime, { recursive: true }),
      mkdir(join(taskboard, "server"), { recursive: true }),
    ]);
    await Promise.all([
      copyFile(fileURLToPath(files.stop), stopScript),
      writeFile(
        helperScript,
        `${helperSource}\nfunction Stop-IdentityVerifiedNodeProcess([object]$Process, [string]$Script, [object]$ExpectedIdentity) { & taskkill.exe /PID $Process.ProcessId /T /F | Out-Null; if ($LASTEXITCODE -ne 0) { throw 'mock taskkill failed' }; return $true }\n`,
        "utf8",
      ),
      writeFile(pidFile, String(fakePid), "utf8"),
    ]);

    const commandLine = `"${nodeExecutable}" "${taskboardScript}"`;
    const command = [
      `$env:CODEX_TASKBOARD_ROOT = ${powershellLiteral(taskboard)}`,
      `. ${powershellLiteral(helperScript)}`,
      "$created = [DateTime]::SpecifyKind([DateTime]'2026-08-20T00:00:00', [DateTimeKind]::Utc)",
      `$global:fakeProcess = [pscustomobject]@{ ProcessId = ${fakePid}; CreationDate = $created; ExecutablePath = ${powershellLiteral(nodeExecutable)}; CommandLine = ${powershellLiteral(commandLine)} }`,
      `Write-PersistedProcessIdentity ${powershellLiteral(identityFile)} $global:fakeProcess`,
      "function global:Get-CimInstance { [CmdletBinding()] param([Parameter(Position=0)][string]$ClassName, [string]$Filter) $global:fakeProcess }",
      `function global:taskkill.exe { [System.IO.File]::WriteAllText(${powershellLiteral(killMarker)}, 'called'); $global:LASTEXITCODE = 0 }`,
      `& ${powershellLiteral(stopScript)}`,
    ].join(";");
    const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", command], {
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(await readFile(killMarker, "utf8"), "called");
    await assert.rejects(access(pidFile));
    await assert.rejects(access(identityFile));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("startup stops an identity-verified Taskboard that no longer owns its port", async () => {
  const start = await readFile(files.start, "utf8");
  assert.doesNotMatch(start, /Recorded process .*leaving it running/);
  assert.match(
    start,
    /if \(-not \$tracksMode\) \{\s*if \(\$portMatches\) \{ return \$oldPid \}\s*Stop-ValidatedNode \$old \$Script \$persistedIdentity/s,
  );
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
  const [source, helper] = await Promise.all([
    readFile(files.stop, "utf8"),
    readFile(files.processIdentity, "utf8"),
  ]);
  assert.match(source, /taskboard\.pid/);
  assert.match(source, /bridge\.pid/);
  assert.match(source, /Get-CimInstance Win32_Process/);
  assert.match(helper, /CommandLine/);
  assert.match(source, /Get-Command node\.exe/);
  assert.match(helper, /ExpectedExecutable/);
  assert.match(source, /\$processId/);
  assert.match(helper, /Stop-IdentityVerifiedNodeProcess/);
  assert.match(helper, /TerminateIdentityHandle/);
  assert.match(helper, /OpenProcess/);
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
  assert.match(source, /x-feishu-bridge-client['"]?\s*=\s*['"]local-operator/i);
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
