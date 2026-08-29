param(
  [string]$TaskboardRoot = $null
)

$ErrorActionPreference = 'Stop'

$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path

$taskboardDefaultCandidates = @(
  (Join-Path (Split-Path -Parent $root) 'worktrees\dashi-taskboard-autocut-workflow'),
  (Join-Path (Split-Path -Parent $root) 'dashi-taskboard'),
  'D:\codex\dashi-taskboard'
)

function Resolve-TaskboardRoot(
  [string]$ExplicitRoot = $null,
  [string[]]$DefaultCandidates = $null
) {
  $hasExplicitOverride = -not [string]::IsNullOrWhiteSpace($ExplicitRoot)
  $hasEnvironmentOverride = -not [string]::IsNullOrWhiteSpace($env:CODEX_TASKBOARD_ROOT)
  $candidates = if ($hasExplicitOverride) {
    @($ExplicitRoot)
  } elseif ($hasEnvironmentOverride) {
    @($env:CODEX_TASKBOARD_ROOT)
  } elseif ($null -ne $DefaultCandidates -and $DefaultCandidates.Count -gt 0) {
    @($DefaultCandidates)
  } else {
    @($taskboardDefaultCandidates)
  }
  $checked = New-Object System.Collections.ArrayList
  $firstExistingDirectory = $null
  foreach ($candidate in $candidates) {
    $requestedRoot = [string]$candidate
    if ([string]::IsNullOrWhiteSpace($requestedRoot)) { continue }
    if (-not [System.IO.Path]::IsPathRooted($requestedRoot)) {
      if ($hasExplicitOverride -or $hasEnvironmentOverride) {
        throw "Taskboard root must be an absolute path: $requestedRoot"
      }
      [void]$checked.Add("$requestedRoot (not absolute)")
      continue
    }
    try {
      $resolvedRoot = (Resolve-Path -LiteralPath $requestedRoot -ErrorAction Stop).Path
    } catch {
      [void]$checked.Add("$requestedRoot (not found)")
      continue
    }
    if (-not (Test-Path -LiteralPath $resolvedRoot -PathType Container)) {
      [void]$checked.Add("$resolvedRoot (not a directory)")
      continue
    }
    if ($hasExplicitOverride -or $hasEnvironmentOverride) {
      return $resolvedRoot
    }
    if ($null -eq $firstExistingDirectory) {
      $firstExistingDirectory = $resolvedRoot
    }
    if (Test-Path -LiteralPath (Join-Path $resolvedRoot 'server\index.mjs') -PathType Leaf) {
      return $resolvedRoot
    }
    [void]$checked.Add("$resolvedRoot (missing server\index.mjs)")
  }
  if ($null -ne $firstExistingDirectory) {
    return $firstExistingDirectory
  }
  throw "No Taskboard checkout was found. Checked: $($checked -join '; '). Set -TaskboardRoot or CODEX_TASKBOARD_ROOT to a Taskboard checkout."
}

$runtime = Join-Path $root '.runtime'
$taskboardRoot = Resolve-TaskboardRoot $TaskboardRoot $taskboardDefaultCandidates
. (Join-Path $root 'scripts\process-identity.ps1')
$nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
$node = if ($nodeCommand) { $nodeCommand.Source } else { 'C:\Program Files\nodejs\node.exe' }

$targets = @(
  @{
    Name = 'taskboard'
    File = Join-Path $runtime 'taskboard.pid'
    IdentityFile = Join-Path $runtime 'taskboard.process.json'
    Match = Join-Path $taskboardRoot 'server\index.mjs'
    Node = $node
    ModeFile = $null
  },
  @{
    Name = 'bridge'
    File = Join-Path $runtime 'bridge.pid'
    IdentityFile = Join-Path $runtime 'bridge.process.json'
    Match = Join-Path $root 'src\index.mjs'
    Node = $node
    ModeFile = Join-Path $runtime 'bridge.feishu-mode'
  }
)

function Remove-TargetMarkerFiles([hashtable]$Target) {
  Remove-Item -LiteralPath $Target.File -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $Target.IdentityFile -Force -ErrorAction SilentlyContinue
  if (-not [string]::IsNullOrWhiteSpace($Target.ModeFile)) {
    Remove-Item -LiteralPath $Target.ModeFile -Force -ErrorAction SilentlyContinue
  }
}

function Remove-TargetMarkersIfUnchanged(
  [hashtable]$Target,
  [int]$ExpectedPid,
  [object]$ExpectedIdentity = $null,
  [object]$ExpectedIdentitySnapshot = $null,
  [object]$ExpectedModeSnapshot = $null,
  [switch]$AllowInvalidIdentity
) {
  if ($ExpectedIdentity) {
    if (-not [string]::IsNullOrWhiteSpace($Target.ModeFile) -and
      -not (Test-ProcessMarkerFileSnapshot $Target.ModeFile $ExpectedModeSnapshot)) {
      return $false
    }
    $additionalFiles = if ([string]::IsNullOrWhiteSpace($Target.ModeFile)) { @() } else { @($Target.ModeFile) }
    $additionalSnapshots = if ($additionalFiles.Count -eq 0) { @() } else { @($ExpectedModeSnapshot) }
    return (Remove-PersistedProcessMarkersIfMatch $Target.File $Target.IdentityFile $ExpectedIdentity $additionalFiles $additionalSnapshots)
  }
  if (-not [string]::IsNullOrWhiteSpace($Target.ModeFile) -and
    -not (Test-ProcessMarkerFileSnapshot $Target.ModeFile $ExpectedModeSnapshot)) {
    return $false
  }
  $currentPid = Read-PersistedProcessId $Target.File
  if ($null -eq $currentPid -or $currentPid -ne $ExpectedPid) { return $false }
  if (-not $AllowInvalidIdentity -or
    -not (Test-ProcessMarkerFileSnapshot $Target.IdentityFile $ExpectedIdentitySnapshot)) {
    return $false
  }
  Remove-TargetMarkerFiles $Target
  return $true
}

function Get-TargetProcessQuery([int]$ProcessId) {
  try {
    $matches = @(Get-CimInstance Win32_Process -Filter "ProcessId=$ProcessId" -ErrorAction Stop)
    if ($matches.Count -gt 1) {
      return [pscustomobject]@{
        Succeeded = $false
        Process = $null
        Error = "Multiple Win32_Process records returned for PID $ProcessId."
      }
    }
    return [pscustomobject]@{
      Succeeded = $true
      Process = if ($matches.Count -eq 0) { $null } else { $matches[0] }
      Error = $null
    }
  } catch {
    return [pscustomobject]@{
      Succeeded = $false
      Process = $null
      Error = $_.Exception.Message
    }
  }
}

$lifecycleMutex = New-Object System.Threading.Mutex($false, 'Local\CodexFeishuTaskboardLifecycle')
$lifecycleMutexAcquired = $false
$refusedTargets = @()
try {
  try {
    $lifecycleMutexAcquired = $lifecycleMutex.WaitOne(0)
  } catch [System.Threading.AbandonedMutexException] {
    $lifecycleMutexAcquired = $true
  }
  if (-not $lifecycleMutexAcquired) { throw 'Another Taskboard start or stop operation is already in progress.' }

  foreach ($target in $targets) {
    try {
      $identitySnapshot = Get-ProcessMarkerFileSnapshot $target.IdentityFile
      $pidPathPresent = Test-Path -LiteralPath $target.File
      $pidMarkerPresent = Test-Path -LiteralPath $target.File -PathType Leaf
      $identityFilePresent = Test-Path -LiteralPath $target.IdentityFile
      $modeSnapshot = if ([string]::IsNullOrWhiteSpace($target.ModeFile)) { $null } else { Get-ProcessMarkerFileSnapshot $target.ModeFile }
      $processId = Read-PersistedProcessId $target.File
      $identity = Read-PersistedProcessIdentity $target.IdentityFile
      $markerState = 'valid'

      if ($null -eq $processId) {
        if ($identity) {
          $processId = [int]$identity.Pid
          $markerState = if ($pidPathPresent -and -not $pidMarkerPresent) {
            'non-leaf-pid'
          } elseif ($pidMarkerPresent) {
            'malformed-pid'
          } else {
            'missing-pid'
          }
        } elseif ($pidPathPresent -or $identityFilePresent) {
          Write-Warning "Skipped $($target.Name): PID or identity marker was missing or malformed; leaving markers unchanged."
          $refusedTargets += $target.Name
          continue
        } else {
          if (-not [string]::IsNullOrWhiteSpace($target.ModeFile)) {
            if (Test-ProcessMarkerFileSnapshot $target.ModeFile $modeSnapshot) {
              Remove-Item -LiteralPath $target.ModeFile -Force -ErrorAction SilentlyContinue
            } else {
              Write-Warning "Skipped $($target.Name): mode marker changed while no process markers were present; leaving it unchanged."
              $refusedTargets += $target.Name
            }
          }
          continue
        }
      } elseif ($identity -and [int]$identity.Pid -ne [int]$processId) {
        Write-Warning "Skipped $($target.Name): PID and identity markers disagree; leaving the process and markers unchanged."
        $refusedTargets += $target.Name
        continue
      }

      $query = Get-TargetProcessQuery $processId
      if (-not $query.Succeeded) {
        Write-Warning "Skipped $($target.Name): could not query PID $processId; leaving the process and markers unchanged. ($($query.Error))"
        $refusedTargets += $target.Name
        continue
      }
      $process = $query.Process
      if (-not $process) {
        Write-Host "Already stopped $($target.Name) (stale PID $processId)"
        if ($markerState -eq 'valid' -and $identity) {
          if (-not (Remove-TargetMarkersIfUnchanged $target $processId $identity $null $modeSnapshot)) {
            Write-Warning "Could not remove stale $($target.Name) markers because they changed."
            $refusedTargets += $target.Name
          }
        } elseif ($markerState -eq 'valid') {
          if (-not (Remove-TargetMarkersIfUnchanged $target $processId -ExpectedIdentitySnapshot $identitySnapshot -ExpectedModeSnapshot $modeSnapshot -AllowInvalidIdentity)) {
            Write-Warning "Could not remove stale $($target.Name) markers because they changed."
            $refusedTargets += $target.Name
          }
        } else {
          Write-Warning "Skipped stale $($target.Name) cleanup because its PID marker was $markerState; leaving markers unchanged."
          $refusedTargets += $target.Name
        }
        continue
      }

      if ($markerState -ne 'valid' -or -not $identity) {
        if ($markerState -eq 'valid' -and -not $identity) {
          Write-Warning "Skipped $($target.Name): legacy PID-only marker cannot authorize termination; leaving it running. Run the start launcher once to migrate it safely, then stop again."
          $refusedTargets += $target.Name
          Remove-TargetMarkersIfUnchanged $target $processId -ExpectedIdentitySnapshot $identitySnapshot -ExpectedModeSnapshot $modeSnapshot -AllowInvalidIdentity | Out-Null
        } else {
          Write-Warning "Skipped $($target.Name): $markerState marker cannot authorize termination; leaving it running. Run the start launcher once to migrate it safely, then stop again."
          $refusedTargets += $target.Name
        }
        continue
      }
      if (-not (Test-PersistedProcessIdentity $process $identity) -or
        -not (Test-NodeScriptProcess $process $target.Match $target.Node)) {
        Write-Warning "Skipped $($target.Name): persisted process identity did not match; leaving it running."
        $refusedTargets += $target.Name
        continue
      }

      try {
        $stopped = Stop-IdentityVerifiedNodeProcess $process $target.Match $identity $target.Node
      } catch {
        Write-Warning "Could not safely stop $($target.Name) (PID $processId); leaving it running. $($_.Exception.Message)"
        $refusedTargets += $target.Name
        continue
      }
      if (-not $stopped) {
        $afterQuery = Get-TargetProcessQuery $processId
        if (-not $afterQuery.Succeeded) {
          Write-Warning "Could not determine whether $($target.Name) stopped; leaving markers unchanged. ($($afterQuery.Error))"
          $refusedTargets += $target.Name
          continue
        }
        if ($afterQuery.Process) {
          Write-Warning "Could not stop $($target.Name) (PID $processId); leaving it running."
          $refusedTargets += $target.Name
          continue
        }
      }

      try {
        if (-not (Remove-TargetMarkersIfUnchanged $target $processId $identity $null $modeSnapshot)) {
          Write-Warning "Stopped $($target.Name), but its markers changed before cleanup; leaving them in place."
          $refusedTargets += $target.Name
          continue
        }
      } catch {
        Write-Warning "Stopped $($target.Name), but marker cleanup failed; leaving the markers in place. $($_.Exception.Message)"
        $refusedTargets += $target.Name
        continue
      }
      Write-Host "Stopped $($target.Name) (PID $processId)"
    } catch {
      Write-Warning "Skipped $($target.Name) after an unexpected stop error; leaving its process and markers unchanged. $($_.Exception.Message)"
      $refusedTargets += $target.Name
      continue
    }
  }
  if ($refusedTargets.Count -gt 0) {
    throw "Could not safely stop all services; check the warnings above for: $($refusedTargets -join ', ')."
  }
} finally {
  if ($lifecycleMutexAcquired) {
    try { $lifecycleMutex.ReleaseMutex() } catch {}
  }
  $lifecycleMutex.Dispose()
}
