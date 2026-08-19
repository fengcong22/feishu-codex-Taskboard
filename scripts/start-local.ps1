param(
  [switch]$EnableFeishu
)

$ErrorActionPreference = 'Stop'

$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$taskboardRoot = if ($env:CODEX_TASKBOARD_ROOT) { (Resolve-Path $env:CODEX_TASKBOARD_ROOT).Path } else { 'D:\codex\dashi-taskboard' }
$runtime = Join-Path $root '.runtime'
$logs = Join-Path $runtime 'logs'
$taskboardData = Join-Path $runtime 'taskboard'
$bridgeData = Join-Path $runtime 'bridge'
$config = Join-Path $root 'config\bridge.local.json'
$taskboardPidFile = Join-Path $runtime 'taskboard.pid'
$bridgePidFile = Join-Path $runtime 'bridge.pid'
$bridgeModeFile = Join-Path $runtime 'bridge.feishu-mode'
$taskboardStdout = Join-Path $logs 'taskboard.stdout.log'
$taskboardStderr = Join-Path $logs 'taskboard.stderr.log'
$bridgeStdout = Join-Path $logs 'bridge.stdout.log'
$bridgeStderr = Join-Path $logs 'bridge.stderr.log'
$launcher = Join-Path $root 'scripts\detached-launcher.mjs'
$nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
$node = if ($nodeCommand) { $nodeCommand.Source } else { 'C:\Program Files\nodejs\node.exe' }
$codexCommand = Get-Command codex.exe -ErrorAction SilentlyContinue
$npmRoot = Join-Path $env:APPDATA 'npm\node_modules\@openai\codex\node_modules'
$codexCandidates = @(
  if ($codexCommand) { $codexCommand.Source }
  (Join-Path $npmRoot '@openai\codex-win32-x64\vendor\x86_64-pc-windows-msvc\bin\codex.exe'),
  (Join-Path $npmRoot '@openai\codex-win32-arm64\vendor\aarch64-pc-windows-msvc\bin\codex.exe')
)
$codexExecutable = if ($env:CODEX_EXECUTABLE) { $env:CODEX_EXECUTABLE } else {
  foreach ($candidate in $codexCandidates) {
    try {
      if (Test-Path -LiteralPath $candidate -PathType Leaf) { $candidate; break }
    } catch {}
  }
}

foreach ($directory in @($runtime, $logs, $taskboardData, $bridgeData)) {
  New-Item -ItemType Directory -Force -Path $directory | Out-Null
}
if (-not (Test-Path $config)) {
  Copy-Item (Join-Path $root 'config\bridge.example.json') $config
  Write-Host "Created local config: $config"
}
if ([string]::IsNullOrWhiteSpace($codexExecutable) -or -not (Test-Path -LiteralPath $codexExecutable -PathType Leaf)) {
  throw 'Codex executable was not found. Install the Codex desktop app or set CODEX_EXECUTABLE explicitly.'
}

function Test-Ready([string]$Url) {
  try { return (Invoke-WebRequest $Url -UseBasicParsing -TimeoutSec 2).StatusCode -eq 200 } catch { return $false }
}

function Stop-ValidatedNode([object]$Process, [string]$Script) {
  if (-not $Process) { return }
  $commandLine = ($Process.CommandLine -replace '/', '\')
  $expected = ($Script -replace '/', '\')
  if ($commandLine -notlike "*$expected*") {
    throw "Refusing to stop PID $($Process.ProcessId): command line did not match $Script"
  }
  & taskkill.exe /PID $Process.ProcessId /T /F | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Could not stop PID $($Process.ProcessId)" }
}

function Test-ModeMatch([string]$ModeFile, [string]$RequestedMode) {
  if ([string]::IsNullOrWhiteSpace($ModeFile) -or -not (Test-Path -LiteralPath $ModeFile)) { return $false }
  return ((Get-Content -LiteralPath $ModeFile -Raw).Trim() -eq $RequestedMode)
}

function Start-LocalNode(
  [string]$PidFile,
  [string]$Script,
  [string]$StdoutFile,
  [string]$StderrFile,
  [hashtable]$Environment,
  [string]$ModeFile = $null,
  [string]$RequestedMode = $null
) {
  $tracksMode = -not [string]::IsNullOrWhiteSpace($ModeFile)
  if (Test-Path $PidFile) {
    $oldPid = [int](Get-Content $PidFile -Raw)
    $old = Get-CimInstance Win32_Process -Filter "ProcessId=$oldPid" -ErrorAction SilentlyContinue
    if ($old -and $old.CommandLine -like "*$Script*") {
      if (-not $tracksMode -or (Test-ModeMatch $ModeFile $RequestedMode)) { return $oldPid }
      Stop-ValidatedNode $old $Script
    }
    Remove-Item -LiteralPath $PidFile -Force
    if ($tracksMode) { Remove-Item -LiteralPath $ModeFile -Force -ErrorAction SilentlyContinue }
  }
  $existing = Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like "*$Script*" } | Sort-Object CreationDate -Descending | Select-Object -First 1
  if ($existing) {
    if (-not $tracksMode) {
      Set-Content -LiteralPath $PidFile -Value $existing.ProcessId -NoNewline
      return $existing.ProcessId
    }
    Stop-ValidatedNode $existing $Script
    Remove-Item -LiteralPath $ModeFile -Force -ErrorAction SilentlyContinue
  }
  $arguments = @(
    $launcher,
    '--script', $Script,
    '--cwd', (Split-Path -Parent $Script),
    '--pid-file', $PidFile,
    '--stdout', $StdoutFile,
    '--stderr', $StderrFile
  )
  foreach ($entry in $Environment.GetEnumerator()) {
    $arguments += @('--env', "$($entry.Key)=$($entry.Value)")
  }
  & $node @arguments | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Could not start process for $Script" }
  $deadline = (Get-Date).AddSeconds(15)
  do {
    $candidate = Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like "*$Script*" } | Sort-Object CreationDate -Descending | Select-Object -First 1
    if ($candidate) {
      Set-Content -LiteralPath $PidFile -Value $candidate.ProcessId -NoNewline
      if ($tracksMode) { Set-Content -LiteralPath $ModeFile -Value $RequestedMode -NoNewline }
      return $candidate.ProcessId
    }
    Start-Sleep -Milliseconds 250
  } while ((Get-Date) -lt $deadline)
  throw "Could not start $Script"
}

$taskboardScript = Join-Path $taskboardRoot 'server\index.mjs'
$taskboardPid = Start-LocalNode $taskboardPidFile $taskboardScript $taskboardStdout $taskboardStderr @{
  CODEX_TASKBOARD_HOST = '127.0.0.1'
  CODEX_TASKBOARD_PORT = '47823'
  CODEX_TASKBOARD_DATA_DIR = $taskboardData
  CODEX_EXECUTABLE = $codexExecutable
  CODEX_FEISHU_PACKAGES_PATH = $config
}
if (-not (Test-Ready 'http://127.0.0.1:47823/api/meta')) { throw 'Taskboard is not ready' }

$bridgeScript = Join-Path $root 'src\index.mjs'
$bridgeMode = if ($EnableFeishu) { 'enabled' } else { 'disabled' }
$bridgeEnvironment = @{
  BRIDGE_CONFIG = $config
}
if ($EnableFeishu) {
  $bridgeEnvironment.FEISHU_LISTENER_ENABLED = '1'
}
$bridgePid = Start-LocalNode $bridgePidFile $bridgeScript $bridgeStdout $bridgeStderr $bridgeEnvironment $bridgeModeFile $bridgeMode
if (-not (Test-Ready 'http://127.0.0.1:47824/health')) { throw 'Feishu Bridge is not ready' }

Write-Host "Taskboard started: http://127.0.0.1:47823 (PID $taskboardPid)"
Write-Host "Feishu Bridge started: http://127.0.0.1:47824 (PID $bridgePid)"
if ($EnableFeishu) { Write-Host 'Feishu WebSocket listener requested.' }
Start-Process 'http://127.0.0.1:47823'
