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

function Test-ListeningPortOwner([int]$Port, [int]$ProcessId) {
  try {
    $connections = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop)
    foreach ($connection in $connections) {
      if ([int]$connection.OwningProcess -eq $ProcessId) { return $true }
    }
    return $false
  } catch {
    try {
      $lines = @(netstat.exe -ano -p tcp 2>$null)
      foreach ($line in $lines) {
        $parts = ($line -split '\s+') | Where-Object { $_ -ne '' }
        if ($parts.Count -lt 5 -or $parts[0] -ne 'TCP' -or $parts[3] -ne 'LISTENING') { continue }
        if ($parts[1] -match ':(\d+)$' -and [int]$Matches[1] -eq $Port -and [int]$parts[4] -eq $ProcessId) {
          return $true
        }
      }
    } catch {}
    return $false
  }
}

function Test-Ready([string]$Url, [int]$ExpectedPid = 0, [int]$Port = 0, [string]$ExpectedScript = $null) {
  if ($ExpectedPid -gt 0) {
    $process = Get-CimInstance Win32_Process -Filter "ProcessId=$ExpectedPid" -ErrorAction SilentlyContinue
    if (-not $process -or ($ExpectedScript -and -not (Test-NodeScriptProcess $process $ExpectedScript))) { return $false }
    if ($Port -gt 0 -and -not (Test-ListeningPortOwner $Port $ExpectedPid)) { return $false }
  }
  try { return (Invoke-WebRequest $Url -UseBasicParsing -TimeoutSec 2).StatusCode -eq 200 } catch { return $false }
}

function Wait-Ready([string]$Name, [string]$Url, [int]$ExpectedPid, [int]$Port, [string]$ExpectedScript) {
  $deadline = (Get-Date).AddSeconds(15)
  do {
    if (Test-Ready $Url $ExpectedPid $Port $ExpectedScript) { return }
    Start-Sleep -Milliseconds 250
  } while ((Get-Date) -lt $deadline)
  throw "$Name is not ready"
}

$startedNodes = @{}

function Test-NodeScriptProcess([object]$Process, [string]$Script) {
  if (-not $Process -or [string]::IsNullOrWhiteSpace($Process.CommandLine)) { return $false }
  $executable = [string]$Process.ExecutablePath
  if ([string]::IsNullOrWhiteSpace($executable)) { return $false }
  try {
    if ([System.IO.Path]::GetFileName($executable) -notmatch '(?i)^node(?:\.exe)?$') { return $false }
  } catch {
    return $false
  }
  $commandLine = ($Process.CommandLine -replace '/', '\')
  $normalizedExecutable = ($executable -replace '/', '\')
  $expected = ($Script -replace '/', '\')
  $executableIndex = $commandLine.IndexOf($normalizedExecutable, [System.StringComparison]::OrdinalIgnoreCase)
  if ($executableIndex -lt 0) {
    return $false
  }
  $argumentStart = $executableIndex + $normalizedExecutable.Length
  if ($argumentStart -lt $commandLine.Length -and $commandLine[$argumentStart] -eq '"') {
    $argumentStart++
  }
  $arguments = $commandLine.Substring($argumentStart).TrimStart()
  if ([string]::IsNullOrWhiteSpace($arguments)) { return $false }
  if ($arguments.StartsWith('"')) {
    $closingQuote = $arguments.IndexOf('"', 1)
    if ($closingQuote -lt 0) { return $false }
    $firstArgument = $arguments.Substring(1, $closingQuote - 1)
  } else {
    $separator = $arguments.IndexOf(' ')
    $firstArgument = if ($separator -lt 0) { $arguments } else { $arguments.Substring(0, $separator) }
  }
  return [string]::Equals($firstArgument, $expected, [System.StringComparison]::OrdinalIgnoreCase)
}

function Stop-ValidatedNode([object]$Process, [string]$Script) {
  if (-not $Process) { return }
  if (-not (Test-NodeScriptProcess $Process $Script)) {
    throw "Refusing to stop PID $($Process.ProcessId): command line did not match $Script"
  }
  & taskkill.exe /PID $Process.ProcessId /T /F | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Could not stop PID $($Process.ProcessId)" }
}

function Test-ModeMatch([string]$ModeFile, [string]$RequestedMode) {
  if ([string]::IsNullOrWhiteSpace($ModeFile) -or -not (Test-Path -LiteralPath $ModeFile)) { return $false }
  return ((Get-Content -LiteralPath $ModeFile -Raw).Trim() -eq $RequestedMode)
}

function Get-FeishuListenerState {
  try {
    $health = Invoke-RestMethod -Method Get -Uri 'http://127.0.0.1:47824/health' -TimeoutSec 2
    if ($health.feishuListener -and $health.feishuListener.state) {
      return [string]$health.feishuListener.state
    }
  } catch {}
  return $null
}

function Get-ExpectedListenerState([string]$RequestedMode) {
  if ($RequestedMode -eq 'enabled') { return 'sdk_managed' }
  return 'disabled'
}

function Get-ProcessCreationTicks([object]$Process) {
  try { return ([DateTime]$Process.CreationDate).ToUniversalTime().Ticks } catch { return $null }
}

function Test-StartedNodeIdentity([object]$Process, [hashtable]$Entry) {
  $currentCreation = Get-ProcessCreationTicks $Process
  if ($null -eq $currentCreation) { return $false }
  if ($null -ne $Entry.CreationDate) { return $currentCreation -eq $Entry.CreationDate }
  if ($null -ne $Entry.StartedAt) { return $currentCreation -ge $Entry.StartedAt }
  return $false
}

function Remove-StartedMarkers([hashtable]$Entry, [int]$ProcessId) {
  if (-not (Test-Path -LiteralPath $Entry.PidFile)) { return }
  try {
    $markerPid = (Get-Content -LiteralPath $Entry.PidFile -Raw).Trim()
    if ($markerPid -ne "$ProcessId") { return }
    Remove-Item -LiteralPath $Entry.PidFile -Force -ErrorAction SilentlyContinue
    if (-not [string]::IsNullOrWhiteSpace($Entry.ModeFile)) {
      Remove-Item -LiteralPath $Entry.ModeFile -Force -ErrorAction SilentlyContinue
    }
  } catch {}
}

function Start-LocalNode(
  [string]$PidFile,
  [string]$Script,
  [string]$StdoutFile,
  [string]$StderrFile,
  [hashtable]$Environment,
  [string]$ModeFile = $null,
  [string]$RequestedMode = $null,
  [int]$Port = 0
) {
  $tracksMode = -not [string]::IsNullOrWhiteSpace($ModeFile)
  if (Test-Path $PidFile) {
    $oldPid = [int](Get-Content $PidFile -Raw)
    $old = Get-CimInstance Win32_Process -Filter "ProcessId=$oldPid" -ErrorAction SilentlyContinue
    if ($old -and (Test-NodeScriptProcess $old $Script)) {
      if (-not $tracksMode) {
        if ($Port -le 0 -or (Test-ListeningPortOwner $Port $oldPid)) { return $oldPid }
      } else {
        if (Test-ModeMatch $ModeFile $RequestedMode) {
          $expectedState = Get-ExpectedListenerState $RequestedMode
          if ((Get-FeishuListenerState) -eq $expectedState -and
            ($Port -le 0 -or (Test-ListeningPortOwner $Port $oldPid))) { return $oldPid }
        }
        Stop-ValidatedNode $old $Script
      }
    }
    Remove-Item -LiteralPath $PidFile -Force
    if ($tracksMode) { Remove-Item -LiteralPath $ModeFile -Force -ErrorAction SilentlyContinue }
  }
  $existing = Get-CimInstance Win32_Process |
    Where-Object {
      (Test-NodeScriptProcess $_ $Script) -and
      ($Port -le 0 -or (Test-ListeningPortOwner $Port $_.ProcessId))
    } |
    Sort-Object CreationDate -Descending |
    Select-Object -First 1
  if ($existing) {
    if (-not $tracksMode) {
      Set-Content -LiteralPath $PidFile -Value $existing.ProcessId -NoNewline
      return $existing.ProcessId
    }
    $existingState = Get-FeishuListenerState
    $expectedState = Get-ExpectedListenerState $RequestedMode
    if (Test-ModeMatch $ModeFile $RequestedMode -and $existingState -eq $expectedState) {
      Set-Content -LiteralPath $PidFile -Value $existing.ProcessId -NoNewline
      return $existing.ProcessId
    }
    if ($existingState -eq $expectedState) {
      Set-Content -LiteralPath $PidFile -Value $existing.ProcessId -NoNewline
      Set-Content -LiteralPath $ModeFile -Value $RequestedMode -NoNewline
      return $existing.ProcessId
    }
    throw "A Feishu Bridge process is already running without a matching runtime ownership marker (state: $existingState). Stop it before starting a different mode."
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
  $launchStartedAt = ([DateTime]::UtcNow).Ticks
  $launcherOutput = @(& $node @arguments)
  $launcherExitCode = $LASTEXITCODE
  $launchedPid = $null
  foreach ($line in $launcherOutput) {
    $parsedPid = 0
    if ([int]::TryParse(([string]$line).Trim(), [ref]$parsedPid) -and $parsedPid -gt 0) {
      $launchedPid = $parsedPid
    }
  }
  if ($null -eq $launchedPid -and (Test-Path -LiteralPath $PidFile)) {
    try {
      $pidFromFile = 0
      if ([int]::TryParse((Get-Content -LiteralPath $PidFile -Raw).Trim(), [ref]$pidFromFile) -and $pidFromFile -gt 0) {
        $launchedPid = $pidFromFile
      }
    } catch {}
  }
  if ($null -ne $launchedPid) {
    $startedNodes[$launchedPid] = @{
      Script = $Script
      PidFile = $PidFile
      ModeFile = $ModeFile
      StartedAt = $launchStartedAt
      CreationDate = $null
    }
  }
  if ($launcherExitCode -ne 0) { throw "Could not start process for $Script" }
  if ($null -eq $launchedPid) { throw "Detached launcher did not return a PID for $Script" }
  $deadline = (Get-Date).AddSeconds(15)
  do {
    $candidate = Get-CimInstance Win32_Process -Filter "ProcessId=$launchedPid" -ErrorAction SilentlyContinue
    if ($candidate) {
      if (-not (Test-NodeScriptProcess $candidate $Script)) {
        throw "Detached launcher PID $launchedPid does not match $Script"
      }
      $startedNodes[$launchedPid].CreationDate = Get-ProcessCreationTicks $candidate
      Set-Content -LiteralPath $PidFile -Value $launchedPid -NoNewline
      if ($tracksMode) { Set-Content -LiteralPath $ModeFile -Value $RequestedMode -NoNewline }
      return $launchedPid
    }
    Start-Sleep -Milliseconds 250
  } while ((Get-Date) -lt $deadline)
  throw "Could not start $Script"
}

function Stop-StartedNodes {
  foreach ($entry in @($startedNodes.GetEnumerator())) {
    $node = Get-CimInstance Win32_Process -Filter "ProcessId=$($entry.Key)" -ErrorAction SilentlyContinue
    $removeMarkers = $true
    if ($node) {
      if (-not (Test-StartedNodeIdentity $node $entry.Value)) {
        Write-Warning "Could not verify identity of started process $($entry.Key); leaving it running."
        $removeMarkers = $false
      } else {
        try {
          Stop-ValidatedNode $node $entry.Value.Script
        } catch {
          Write-Warning "Could not clean up started process $($entry.Key)."
          $removeMarkers = $false
        }
      }
    }
    if ($removeMarkers) {
      Remove-StartedMarkers $entry.Value ([int]$entry.Key)
    }
  }
}

function Wait-FeishuReady([int]$BridgePid, [string]$BridgeScript) {
  $deadline = (Get-Date).AddSeconds(30)
  $lastState = 'unavailable'
  do {
    $bridgeProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$BridgePid" -ErrorAction SilentlyContinue
    if (-not $bridgeProcess) {
      throw 'Feishu Bridge exited before the SDK-managed listener became ready. Check .runtime\logs\bridge.stderr.log.'
    }
    if (-not (Test-NodeScriptProcess $bridgeProcess $BridgeScript)) {
      throw 'Feishu Bridge PID no longer matches the expected process. Check .runtime\logs\bridge.stderr.log.'
    }
    if (-not (Test-ListeningPortOwner 47824 $BridgePid)) {
      throw 'Feishu Bridge PID does not own the health endpoint port. Check .runtime\logs\bridge.stderr.log.'
    }
    try {
      $health = Invoke-RestMethod -Method Get -Uri 'http://127.0.0.1:47824/health' -TimeoutSec 2
      $lastState = if ($health.feishuListener -and $health.feishuListener.state) {
        [string]$health.feishuListener.state
      } else {
        'unknown'
      }
    } catch {
      $lastState = 'unavailable'
    }
    if ($lastState -eq 'sdk_managed') { return }
    if ($lastState -eq 'error') {
      throw 'Feishu listener failed to start. Check .runtime\logs\bridge.stderr.log.'
    }
    Start-Sleep -Milliseconds 250
  } while ((Get-Date) -lt $deadline)
  throw "Feishu listener did not become SDK-managed within 30 seconds (state: $lastState). Check .runtime\logs\bridge.stderr.log."
}

$startupMutex = New-Object System.Threading.Mutex($false, 'Local\CodexFeishuTaskboardStartup')
$startupMutexAcquired = $false
try {
  try {
    $startupMutexAcquired = $startupMutex.WaitOne(0)
  } catch [System.Threading.AbandonedMutexException] {
    $startupMutexAcquired = $true
  }
  if (-not $startupMutexAcquired) { throw 'Another Taskboard startup is already in progress.' }

  $taskboardScript = Join-Path $taskboardRoot 'server\index.mjs'
  $taskboardPid = Start-LocalNode $taskboardPidFile $taskboardScript $taskboardStdout $taskboardStderr @{
    CODEX_TASKBOARD_HOST = '127.0.0.1'
    CODEX_TASKBOARD_PORT = '47823'
    CODEX_TASKBOARD_DATA_DIR = $taskboardData
    CODEX_EXECUTABLE = $codexExecutable
    CODEX_FEISHU_PACKAGES_PATH = $config
  } $null $null 47823
  Wait-Ready 'Taskboard' 'http://127.0.0.1:47823/api/meta' $taskboardPid 47823 $taskboardScript

  $bridgeScript = Join-Path $root 'src\index.mjs'
  $bridgeMode = if ($EnableFeishu) { 'enabled' } else { 'disabled' }
  $bridgeEnvironment = @{
    BRIDGE_CONFIG = $config
  }
  if ($EnableFeishu) {
    $bridgeEnvironment.FEISHU_LISTENER_ENABLED = '1'
  }
  $bridgePid = Start-LocalNode $bridgePidFile $bridgeScript $bridgeStdout $bridgeStderr $bridgeEnvironment $bridgeModeFile $bridgeMode 47824
  Wait-Ready 'Feishu Bridge' 'http://127.0.0.1:47824/health' $bridgePid 47824 $bridgeScript
  if ($EnableFeishu) { Wait-FeishuReady $bridgePid $bridgeScript }

  Write-Host "Taskboard started: http://127.0.0.1:47823 (PID $taskboardPid)"
  Write-Host "Feishu Bridge started: http://127.0.0.1:47824 (PID $bridgePid)"
  if ($EnableFeishu) { Write-Host 'Feishu WebSocket listener is SDK-managed.' }
  try {
    Start-Process 'http://127.0.0.1:47823'
  } catch {
    Write-Warning 'Could not open the Taskboard browser automatically; the services are still running.'
  }
} catch {
  Stop-StartedNodes
  throw
} finally {
  if ($startupMutexAcquired) {
    try { $startupMutex.ReleaseMutex() } catch {}
  }
  $startupMutex.Dispose()
}
