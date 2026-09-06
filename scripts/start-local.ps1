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
$taskboardIdentityFile = Join-Path $runtime 'taskboard.process.json'
$bridgeIdentityFile = Join-Path $runtime 'bridge.process.json'
$bridgeModeFile = Join-Path $runtime 'bridge.feishu-mode'
$taskboardStdout = Join-Path $logs 'taskboard.stdout.log'
$taskboardStderr = Join-Path $logs 'taskboard.stderr.log'
$bridgeStdout = Join-Path $logs 'bridge.stdout.log'
$bridgeStderr = Join-Path $logs 'bridge.stderr.log'
$launcher = Join-Path $root 'scripts\detached-launcher.mjs'
. (Join-Path $root 'scripts\process-identity.ps1')
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

function Test-Ready(
  [string]$Url,
  [int]$ExpectedPid = 0,
  [int]$Port = 0,
  [string]$ExpectedScript = $null,
  [string]$ExpectedExecutable = $null,
  [object]$ExpectedIdentity = $null
) {
  if ($ExpectedPid -gt 0) {
    if (-not (Test-ExpectedNodeProcess $ExpectedPid $ExpectedScript $ExpectedExecutable $ExpectedIdentity $Port)) { return $false }
  }
  try {
    if ((Invoke-WebRequest $Url -UseBasicParsing -TimeoutSec 2).StatusCode -ne 200) { return $false }
  } catch { return $false }
  if ($ExpectedPid -le 0) { return $true }
  return (Test-ExpectedNodeProcess $ExpectedPid $ExpectedScript $ExpectedExecutable $ExpectedIdentity $Port)
}

function Wait-Ready(
  [string]$Name,
  [string]$Url,
  [int]$ExpectedPid,
  [int]$Port,
  [string]$ExpectedScript,
  [string]$ExpectedExecutable,
  [object]$ExpectedIdentity
) {
  $deadline = (Get-Date).AddSeconds(15)
  do {
    if (Test-Ready $Url $ExpectedPid $Port $ExpectedScript $ExpectedExecutable $ExpectedIdentity) { return }
    Start-Sleep -Milliseconds 250
  } while ((Get-Date) -lt $deadline)
  throw "$Name is not ready"
}

$startedNodes = New-Object System.Collections.ArrayList

function Stop-ValidatedNode([object]$Process, [string]$Script, [object]$ExpectedIdentity, [string]$ExpectedExecutable) {
  Stop-IdentityVerifiedNodeProcess $Process $Script $ExpectedIdentity $ExpectedExecutable | Out-Null
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

function New-BridgeSecret {
  $configured = [string]$env:CODEX_FEISHU_BRIDGE_SECRET
  if (-not [string]::IsNullOrWhiteSpace($configured)) {
    if ($configured -match '[\x00-\x1f\x7f]') {
      throw 'CODEX_FEISHU_BRIDGE_SECRET contains control characters.'
    }
    return $configured
  }

  $bytes = New-Object byte[] 32
  $generator = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try {
    $generator.GetBytes($bytes)
  } finally {
    $generator.Dispose()
  }
  return ([Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_'))
}

function Test-StartedNodeIdentity([object]$Process, [hashtable]$Entry) {
  if ($null -eq $Entry.CreationDate) { return $false }
  $currentCreation = Get-ProcessCreationTicks $Process
  if ($null -eq $currentCreation) { return $false }
  return $currentCreation -eq $Entry.CreationDate
}

function Set-ProcessMarkers(
  [string]$PidFile,
  [string]$IdentityFile,
  [object]$Process,
  [string]$ModeFile = $null,
  [string]$RequestedMode = $null,
  [object]$ExpectedPidSnapshot = $null,
  [object]$ExpectedIdentitySnapshot = $null,
  [object]$ExpectedModeSnapshot = $null
) {
  if ($null -ne $ExpectedPidSnapshot -or $null -ne $ExpectedIdentitySnapshot -or $null -ne $ExpectedModeSnapshot) {
    if (-not (Test-ProcessMarkerFileSnapshot $PidFile $ExpectedPidSnapshot) -or
      -not (Test-ProcessMarkerFileSnapshot $IdentityFile $ExpectedIdentitySnapshot) -or
      (-not [string]::IsNullOrWhiteSpace($ModeFile) -and
        -not (Test-ProcessMarkerFileSnapshot $ModeFile $ExpectedModeSnapshot))) {
      throw 'Process markers changed before ownership could be persisted.'
    }
  }
  Set-Content -LiteralPath $PidFile -Value $Process.ProcessId -NoNewline
  Write-PersistedProcessIdentity $IdentityFile $Process
  if (-not [string]::IsNullOrWhiteSpace($ModeFile)) {
    Set-Content -LiteralPath $ModeFile -Value $RequestedMode -NoNewline
  }
}

function Remove-ProcessMarkerFilesIfUnchanged(
  [string]$PidFile,
  [string]$IdentityFile,
  [string]$ModeFile,
  [object]$PidSnapshot,
  [object]$IdentitySnapshot,
  [object]$ModeSnapshot
) {
  if (-not (Test-ProcessMarkerFileSnapshot $PidFile $PidSnapshot) -or
    -not (Test-ProcessMarkerFileSnapshot $IdentityFile $IdentitySnapshot)) {
    return $false
  }
  if (-not [string]::IsNullOrWhiteSpace($ModeFile) -and
    -not (Test-ProcessMarkerFileSnapshot $ModeFile $ModeSnapshot)) {
    return $false
  }
  try {
    Remove-Item -LiteralPath $PidFile -Force -ErrorAction Stop
    Remove-Item -LiteralPath $IdentityFile -Force -ErrorAction Stop
    if (-not [string]::IsNullOrWhiteSpace($ModeFile)) {
      Remove-Item -LiteralPath $ModeFile -Force -ErrorAction Stop
    }
    return $true
  } catch {
    return $false
  }
}

function Remove-StartedMarkers([hashtable]$Entry, [object]$ExpectedIdentity) {
  $additionalFiles = if ([string]::IsNullOrWhiteSpace($Entry.ModeFile)) { @() } else { @($Entry.ModeFile) }
  $additionalSnapshots = if ($additionalFiles.Count -eq 0) { @() } else { @($Entry.ModeSnapshot) }
  Remove-PersistedProcessMarkersIfMatch $Entry.PidFile $Entry.IdentityFile $ExpectedIdentity $additionalFiles $additionalSnapshots | Out-Null
}

function Start-LocalNode(
  [string]$PidFile,
  [string]$IdentityFile,
  [string]$Script,
  [string]$StdoutFile,
  [string]$StderrFile,
  [hashtable]$Environment,
  [string]$ModeFile = $null,
  [string]$RequestedMode = $null,
  [int]$Port = 0
) {
  $tracksMode = -not [string]::IsNullOrWhiteSpace($ModeFile)
  [int]$blockedPid = 0
  $pidMarkerSnapshot = Get-ProcessMarkerFileSnapshot $PidFile
  $identityMarkerSnapshot = Get-ProcessMarkerFileSnapshot $IdentityFile
  $modeMarkerSnapshot = if ($tracksMode) { Get-ProcessMarkerFileSnapshot $ModeFile } else { $null }
  if (Test-Path -LiteralPath $PidFile) {
    $oldPid = Read-PersistedProcessId $PidFile
    if ($null -eq $oldPid) {
      Write-Warning "Ignoring malformed PID marker $PidFile."
      if (-not (Remove-ProcessMarkerFilesIfUnchanged $PidFile $IdentityFile $ModeFile $pidMarkerSnapshot $identityMarkerSnapshot $modeMarkerSnapshot)) {
        throw "Could not safely clear malformed process markers for $PidFile; leaving them unchanged."
      }
    } else {
      $oldQuery = Get-ProcessQueryResult $oldPid
      if (-not $oldQuery.Succeeded) {
        throw "Could not query persisted PID $oldPid; leaving its process and markers unchanged. ($($oldQuery.Error))"
      }
      $old = $oldQuery.Process
      $identityFilePresent = Test-Path -LiteralPath $IdentityFile
      $persistedIdentity = Read-PersistedProcessIdentity $IdentityFile
      if (-not $old) {
        if (-not (Remove-ProcessMarkerFilesIfUnchanged $PidFile $IdentityFile $ModeFile $pidMarkerSnapshot $identityMarkerSnapshot $modeMarkerSnapshot)) {
          throw "Could not safely clear stale process markers for PID $oldPid; leaving them unchanged."
        }
      } else {
        $scriptMatches = Test-NodeScriptProcess $old $Script $node
        $portMatches = $Port -le 0 -or (Test-ListeningPortOwner $Port $oldPid)
        $identityMatches = $persistedIdentity -and (Test-PersistedProcessIdentity $old $persistedIdentity)

        if ($identityMatches -and $scriptMatches) {
          if (-not $tracksMode) {
            if ($portMatches) { return $oldPid }
            Stop-ValidatedNode $old $Script $persistedIdentity $node
            if (-not (Remove-PersistedProcessMarkersIfMatch $PidFile $IdentityFile $persistedIdentity)) {
              throw "Stopped PID $oldPid, but its ownership markers changed before cleanup."
            }
          } else {
            $expectedState = Get-ExpectedListenerState $RequestedMode
            if ($portMatches -and (Get-FeishuListenerState) -eq $expectedState) {
              if (-not (Test-ExpectedNodeProcess $oldPid $Script $node $persistedIdentity $Port) -or
                -not (Test-ProcessMarkerFileSnapshot $PidFile $pidMarkerSnapshot) -or
                -not (Test-ProcessMarkerFileSnapshot $IdentityFile $identityMarkerSnapshot) -or
                -not (Test-ProcessMarkerFileSnapshot $ModeFile $modeMarkerSnapshot)) {
                throw "Bridge PID $oldPid or its ownership markers changed during mode validation."
              }
              Set-Content -LiteralPath $ModeFile -Value $RequestedMode -NoNewline
              return $oldPid
            }
            Stop-ValidatedNode $old $Script $persistedIdentity $node
            $additionalFiles = if ([string]::IsNullOrWhiteSpace($ModeFile)) { @() } else { @($ModeFile) }
            $additionalSnapshots = if ($additionalFiles.Count -eq 0) { @() } else { @($modeMarkerSnapshot) }
            if (-not (Remove-PersistedProcessMarkersIfMatch $PidFile $IdentityFile $persistedIdentity $additionalFiles $additionalSnapshots)) {
              throw "Stopped Bridge PID $oldPid, but its ownership markers changed before cleanup."
            }
          }
        } elseif (-not $identityFilePresent -and $scriptMatches -and $portMatches) {
          # A legacy PID-only marker is adopted only after script, port, and mode health checks.
          if (-not $tracksMode) {
            if (Test-Ready 'http://127.0.0.1:47823/api/meta' $oldPid $Port $Script $node) {
              $verifiedOld = Get-VerifiedCurrentNodeProcess $old $Script $Port $node
              if ($verifiedOld) {
                Set-ProcessMarkers $PidFile $IdentityFile $verifiedOld $null $null $pidMarkerSnapshot $identityMarkerSnapshot $null
                return $verifiedOld.ProcessId
              }
            }
            Write-Warning "Could not verify the health and identity of legacy process $oldPid; leaving it running."
            $blockedPid = $oldPid
            if (-not (Remove-ProcessMarkerFilesIfUnchanged $PidFile $IdentityFile $ModeFile $pidMarkerSnapshot $identityMarkerSnapshot $modeMarkerSnapshot)) {
              throw "Could not safely clear legacy process markers for PID $oldPid; leaving them unchanged."
            }
          } else {
            $expectedState = Get-ExpectedListenerState $RequestedMode
            $listenerState = Get-FeishuListenerState
            if ($listenerState -eq $expectedState) {
              $verifiedOld = Get-VerifiedCurrentNodeProcess $old $Script $Port $node
              if ($verifiedOld) {
                Set-ProcessMarkers $PidFile $IdentityFile $verifiedOld $ModeFile $RequestedMode $pidMarkerSnapshot $identityMarkerSnapshot $modeMarkerSnapshot
                return $verifiedOld.ProcessId
              }
            }
            Write-Warning "Could not verify the mode and identity of legacy process $oldPid; leaving it running."
            $blockedPid = $oldPid
            if (-not (Remove-ProcessMarkerFilesIfUnchanged $PidFile $IdentityFile $ModeFile $pidMarkerSnapshot $identityMarkerSnapshot $modeMarkerSnapshot)) {
              throw "Could not safely clear legacy process markers for PID $oldPid; leaving them unchanged."
            }
          }
        } else {
          Write-Warning "Could not verify persisted identity for process $oldPid; leaving it running."
          if ($scriptMatches -and $portMatches) { $blockedPid = $oldPid }
          if (-not (Remove-ProcessMarkerFilesIfUnchanged $PidFile $IdentityFile $ModeFile $pidMarkerSnapshot $identityMarkerSnapshot $modeMarkerSnapshot)) {
            throw "Could not safely clear process markers for PID $oldPid; leaving them unchanged."
          }
        }
      }
    }
  }

  $pidMarkerSnapshot = Get-ProcessMarkerFileSnapshot $PidFile
  $identityMarkerSnapshot = Get-ProcessMarkerFileSnapshot $IdentityFile
  $modeMarkerSnapshot = if ($tracksMode) { Get-ProcessMarkerFileSnapshot $ModeFile } else { $null }

  $existing = Get-CimInstance Win32_Process |
    Where-Object {
      (Test-NodeScriptProcess $_ $Script $node) -and
      ($Port -le 0 -or (Test-ListeningPortOwner $Port $_.ProcessId))
    } |
    Sort-Object CreationDate -Descending |
    Select-Object -First 1
  if ($existing) {
    if ($blockedPid -gt 0 -and [int]$existing.ProcessId -eq $blockedPid) {
      throw "An unverified process is already using port $Port (PID $blockedPid); it was left running. Stop it manually before starting another instance."
    }
    if (-not $tracksMode) {
      if (-not (Test-Ready 'http://127.0.0.1:47823/api/meta' $existing.ProcessId $Port $Script $node)) {
        throw "An unmarked Taskboard process is using port $Port but its health endpoint is not ready (PID $($existing.ProcessId))."
      }
      $verifiedExisting = Get-VerifiedCurrentNodeProcess $existing $Script $Port $node
      if (-not $verifiedExisting) {
        throw "The unmarked Taskboard process changed after its health check; it was not adopted."
      }
      Set-ProcessMarkers $PidFile $IdentityFile $verifiedExisting $null $null $pidMarkerSnapshot $identityMarkerSnapshot $null
      return $verifiedExisting.ProcessId
    }
    $existingState = Get-FeishuListenerState
    $expectedState = Get-ExpectedListenerState $RequestedMode
    if ($existingState -eq $expectedState) {
      $verifiedExisting = Get-VerifiedCurrentNodeProcess $existing $Script $Port $node
      if (-not $verifiedExisting) {
        throw "The unmarked Feishu Bridge process changed after its health check; it was not adopted."
      }
      Set-ProcessMarkers $PidFile $IdentityFile $verifiedExisting $ModeFile $RequestedMode $pidMarkerSnapshot $identityMarkerSnapshot $modeMarkerSnapshot
      return $verifiedExisting.ProcessId
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
    $launchedPid = Read-PersistedProcessId $PidFile
  }
  $startedEntry = $null
  if ($null -ne $launchedPid) {
    $startedEntry = @{
      Pid = [int]$launchedPid
      Script = $Script
      PidFile = $PidFile
      IdentityFile = $IdentityFile
      ModeFile = $ModeFile
      Node = $node
      CreationDate = $null
      ModeSnapshot = $null
    }
    $startedNodes.Add($startedEntry) | Out-Null
  }
  if ($launcherExitCode -ne 0) { throw "Could not start process for $Script" }
  if ($null -eq $launchedPid) { throw "Detached launcher did not return a PID for $Script" }
  $deadline = (Get-Date).AddSeconds(15)
  do {
    $candidate = Get-CimInstance Win32_Process -Filter "ProcessId=$launchedPid" -ErrorAction SilentlyContinue
    if ($candidate) {
      if (-not (Test-NodeScriptProcess $candidate $Script $node)) {
        throw "Detached launcher PID $launchedPid does not match $Script"
      }
      $creationTicks = Get-ProcessCreationTicks $candidate
      if ($null -eq $creationTicks) { throw "Could not read creation time for PID $launchedPid" }
      $startedEntry.CreationDate = $creationTicks
      $launchPidSnapshot = Get-ProcessMarkerFileSnapshot $PidFile
      $launchIdentitySnapshot = Get-ProcessMarkerFileSnapshot $IdentityFile
      $launchModeSnapshot = if ($tracksMode) { Get-ProcessMarkerFileSnapshot $ModeFile } else { $null }
      Set-ProcessMarkers $PidFile $IdentityFile $candidate $ModeFile $RequestedMode $launchPidSnapshot $launchIdentitySnapshot $launchModeSnapshot
      if ($tracksMode) { $startedEntry.ModeSnapshot = Get-ProcessMarkerFileSnapshot $ModeFile }
      return $launchedPid
    }
    Start-Sleep -Milliseconds 250
  } while ((Get-Date) -lt $deadline)
  throw "Could not start $Script"
}

function Stop-StartedNodes {
  foreach ($entry in @($startedNodes)) {
    [int]$startedPid = $entry.Pid
    $nodeQuery = Get-ProcessQueryResult $startedPid
    $removeMarkers = $true
    $expectedIdentity = $null
    if (-not $nodeQuery.Succeeded) {
      Write-Warning "Could not query started process $startedPid; leaving it and its markers unchanged. ($($nodeQuery.Error))"
      continue
    }
    $node = $nodeQuery.Process
    if ($node) {
      if (-not (Test-StartedNodeIdentity $node $entry)) {
        Write-Warning "Could not verify identity of started process $startedPid; leaving the current PID owner running."
      } else {
        try {
          $expectedIdentity = New-PersistedProcessIdentity $node
          if ($null -eq $expectedIdentity) { throw 'Could not read the started process identity.' }
          Stop-ValidatedNode $node $entry.Script $expectedIdentity $entry.Node
        } catch {
          Write-Warning "Could not clean up started process $startedPid."
          $removeMarkers = $false
        }
      }
    }
    if ($removeMarkers) {
      if ($null -eq $expectedIdentity -and $null -ne $entry.CreationDate) {
        $expectedIdentity = [pscustomobject]@{
          Version = 1
          Pid = $startedPid
          CreationTicks = [long]$entry.CreationDate
        }
      }
      if ($expectedIdentity) {
        try {
          Remove-StartedMarkers $entry $expectedIdentity
        } catch {
          Write-Warning "Could not remove markers for started process $startedPid; continuing cleanup."
        }
      }
    }
  }
}

function Wait-FeishuReady(
  [int]$BridgePid,
  [string]$BridgeScript,
  [string]$ExpectedExecutable,
  [object]$ExpectedIdentity
) {
  $deadline = (Get-Date).AddSeconds(30)
  $lastState = 'unavailable'
  do {
    if (-not (Test-ExpectedNodeProcess $BridgePid $BridgeScript $ExpectedExecutable $ExpectedIdentity 47824)) {
      $bridgeProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$BridgePid" -ErrorAction SilentlyContinue
      if (-not $bridgeProcess) {
      throw 'Feishu Bridge exited before the SDK-managed listener became ready. Check .runtime\logs\bridge.stderr.log.'
      }
      throw 'Feishu Bridge PID no longer matches the expected process. Check .runtime\logs\bridge.stderr.log.'
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
    if ($lastState -eq 'sdk_managed') {
      if (Test-ExpectedNodeProcess $BridgePid $BridgeScript $ExpectedExecutable $ExpectedIdentity 47824) { return }
      throw 'Feishu Bridge process changed after the health response. Check .runtime\logs\bridge.stderr.log.'
    }
    if ($lastState -eq 'error') {
      throw 'Feishu listener failed to start. Check .runtime\logs\bridge.stderr.log.'
    }
    Start-Sleep -Milliseconds 250
  } while ((Get-Date) -lt $deadline)
  throw "Feishu listener did not become SDK-managed within 30 seconds (state: $lastState). Check .runtime\logs\bridge.stderr.log."
}

$startupMutex = New-Object System.Threading.Mutex($false, 'Local\CodexFeishuTaskboardLifecycle')
$startupMutexAcquired = $false
try {
  try {
    $startupMutexAcquired = $startupMutex.WaitOne(0)
  } catch [System.Threading.AbandonedMutexException] {
    $startupMutexAcquired = $true
  }
  if (-not $startupMutexAcquired) { throw 'Another Taskboard startup is already in progress.' }

  $taskboardBridgeSecret = New-BridgeSecret

  $taskboardScript = Join-Path $taskboardRoot 'server\index.mjs'
  $taskboardPid = Start-LocalNode $taskboardPidFile $taskboardIdentityFile $taskboardScript $taskboardStdout $taskboardStderr @{
    CODEX_TASKBOARD_HOST = '127.0.0.1'
    CODEX_TASKBOARD_PORT = '47823'
    CODEX_TASKBOARD_DATA_DIR = $taskboardData
    CODEX_EXECUTABLE = $codexExecutable
    CODEX_FEISHU_PACKAGES_PATH = $config
    CODEX_FEISHU_BRIDGE_SECRET = $taskboardBridgeSecret
  } $null $null 47823
  $taskboardIdentity = Read-PersistedProcessIdentity $taskboardIdentityFile
  if (-not $taskboardIdentity) { throw 'Taskboard process identity marker is missing or invalid after startup.' }
  Wait-Ready 'Taskboard' 'http://127.0.0.1:47823/api/meta' $taskboardPid 47823 $taskboardScript $node $taskboardIdentity

  $bridgeScript = Join-Path $root 'src\index.mjs'
  $bridgeMode = if ($EnableFeishu) { 'enabled' } else { 'disabled' }
  $bridgeEnvironment = @{
    BRIDGE_CONFIG = $config
    CODEX_FEISHU_BRIDGE_SECRET = $taskboardBridgeSecret
  }
  if ($EnableFeishu) {
    $bridgeEnvironment.FEISHU_LISTENER_ENABLED = '1'
  }
  $bridgePid = Start-LocalNode $bridgePidFile $bridgeIdentityFile $bridgeScript $bridgeStdout $bridgeStderr $bridgeEnvironment $bridgeModeFile $bridgeMode 47824
  $bridgeIdentity = Read-PersistedProcessIdentity $bridgeIdentityFile
  if (-not $bridgeIdentity) { throw 'Bridge process identity marker is missing or invalid after startup.' }
  Wait-Ready 'Feishu Bridge' 'http://127.0.0.1:47824/health' $bridgePid 47824 $bridgeScript $node $bridgeIdentity
  if ($EnableFeishu) { Wait-FeishuReady $bridgePid $bridgeScript $node $bridgeIdentity }

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
