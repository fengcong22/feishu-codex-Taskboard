if (-not ('CodexFeishu.ProcessNative' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

namespace CodexFeishu {
  [StructLayout(LayoutKind.Sequential)]
  public struct NativeFileTime {
    public uint Low;
    public uint High;
  }

  public static class ProcessNative {
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint access, bool inheritHandle, int processId);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetProcessTimes(
      IntPtr process,
      out NativeFileTime creation,
      out NativeFileTime exit,
      out NativeFileTime kernel,
      out NativeFileTime user
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateProcess(IntPtr process, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    [DllImport("shell32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern IntPtr CommandLineToArgvW(string commandLine, out int argumentCount);

    [DllImport("kernel32.dll")]
    private static extern IntPtr LocalFree(IntPtr memory);

    public static IntPtr OpenIdentityHandle(int processId) {
      const uint Terminate = 0x00000001;
      const uint Synchronize = 0x00100000;
      const uint QueryLimitedInformation = 0x00001000;
      return OpenProcess(Terminate | Synchronize | QueryLimitedInformation, false, processId);
    }

    public static long GetCreationTicks(IntPtr process) {
      NativeFileTime creation;
      NativeFileTime exit;
      NativeFileTime kernel;
      NativeFileTime user;
      if (!GetProcessTimes(process, out creation, out exit, out kernel, out user)) {
        throw new Win32Exception(Marshal.GetLastWin32Error());
      }
      long fileTime = ((long)creation.High << 32) | creation.Low;
      return DateTime.FromFileTimeUtc(fileTime).Ticks;
    }

    public static bool IsActive(IntPtr process) {
      uint exitCode;
      if (!GetExitCodeProcess(process, out exitCode)) {
        throw new Win32Exception(Marshal.GetLastWin32Error());
      }
      return exitCode == 259;
    }

    public static bool CloseIdentityHandle(IntPtr process) {
      return process == IntPtr.Zero || CloseHandle(process);
    }

    public static bool TerminateIdentityHandle(IntPtr process) {
      return process != IntPtr.Zero && TerminateProcess(process, 1);
    }

    public static bool WaitForExit(IntPtr process, uint milliseconds) {
      return process != IntPtr.Zero && WaitForSingleObject(process, milliseconds) == 0;
    }

    public static string[] ParseCommandLine(string commandLine) {
      int argumentCount;
      IntPtr argumentBlock = CommandLineToArgvW(commandLine, out argumentCount);
      if (argumentBlock == IntPtr.Zero) {
        throw new Win32Exception(Marshal.GetLastWin32Error());
      }
      try {
        string[] arguments = new string[argumentCount];
        for (int index = 0; index < argumentCount; index++) {
          arguments[index] = Marshal.PtrToStringUni(
            Marshal.ReadIntPtr(argumentBlock, index * IntPtr.Size)
          );
        }
        return arguments;
      } finally {
        LocalFree(argumentBlock);
      }
    }
  }
}
'@
}

function Read-PersistedProcessId([string]$PidFile) {
  if ([string]::IsNullOrWhiteSpace($PidFile) -or -not (Test-Path -LiteralPath $PidFile -PathType Leaf)) {
    return $null
  }
  try {
    [int]$processId = 0
    $raw = (Get-Content -LiteralPath $PidFile -Raw -ErrorAction Stop).Trim()
    if (-not [int]::TryParse($raw, [ref]$processId) -or $processId -le 0) { return $null }
    return $processId
  } catch {
    return $null
  }
}

function Get-ProcessCreationTicks([object]$Process) {
  if (-not $Process -or $null -eq $Process.CreationDate) { return $null }
  try {
    return [long]([DateTime]$Process.CreationDate).ToUniversalTime().Ticks
  } catch {
    return $null
  }
}

function Read-PersistedProcessIdentity([string]$IdentityFile) {
  if ([string]::IsNullOrWhiteSpace($IdentityFile) -or -not (Test-Path -LiteralPath $IdentityFile -PathType Leaf)) {
    return $null
  }
  try {
    $document = Get-Content -LiteralPath $IdentityFile -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
    if ($null -eq $document -or $document -is [System.Array]) { return $null }

    [int]$version = 0
    [int]$processId = 0
    [long]$creationTicks = 0
    if (-not [int]::TryParse([string]$document.version, [ref]$version) -or $version -ne 1) { return $null }
    if (-not [int]::TryParse([string]$document.pid, [ref]$processId) -or $processId -le 0) { return $null }
    if ($document.creationTicks -isnot [string] -or $document.creationTicks -notmatch '^[0-9]+$') { return $null }
    if (-not [long]::TryParse($document.creationTicks, [ref]$creationTicks) -or $creationTicks -le 0) { return $null }

    return [pscustomobject]@{
      Version = $version
      Pid = $processId
      CreationTicks = $creationTicks
    }
  } catch {
    return $null
  }
}

function New-PersistedProcessIdentity([object]$Process) {
  if (-not $Process) { return $null }
  [int]$processId = 0
  if (-not [int]::TryParse([string]$Process.ProcessId, [ref]$processId) -or $processId -le 0) { return $null }
  $creationTicks = Get-ProcessCreationTicks $Process
  if ($null -eq $creationTicks -or $creationTicks -le 0) { return $null }
  return [pscustomobject]@{
    Version = 1
    Pid = $processId
    CreationTicks = [long]$creationTicks
  }
}

function Write-PersistedProcessIdentity([string]$IdentityFile, [object]$Process) {
  $identity = New-PersistedProcessIdentity $Process
  if ($null -eq $identity) { throw 'Cannot persist process identity without a valid PID and creation time.' }

  $fullPath = [System.IO.Path]::GetFullPath($IdentityFile)
  $directory = [System.IO.Path]::GetDirectoryName($fullPath)
  if ([string]::IsNullOrWhiteSpace($directory) -or -not [System.IO.Directory]::Exists($directory)) {
    throw "Process identity directory does not exist: $directory"
  }

  $document = [ordered]@{
    version = 1
    pid = [int]$identity.Pid
    creationTicks = ([long]$identity.CreationTicks).ToString([System.Globalization.CultureInfo]::InvariantCulture)
  }
  $json = $document | ConvertTo-Json -Compress
  $writeToken = "$PID.$([Guid]::NewGuid().ToString('N'))"
  $temporaryPath = "$fullPath.$writeToken.tmp"
  $backupPath = "$fullPath.$writeToken.bak"
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  try {
    [System.IO.File]::WriteAllText($temporaryPath, $json, $utf8NoBom)
    if (Test-Path -LiteralPath $fullPath -PathType Leaf) {
      [System.IO.File]::Replace($temporaryPath, $fullPath, $backupPath)
    } else {
      [System.IO.File]::Move($temporaryPath, $fullPath)
    }
  } finally {
    Remove-Item -LiteralPath $temporaryPath -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $backupPath -Force -ErrorAction SilentlyContinue
  }
}

function Test-PersistedProcessIdentity([object]$Process, [object]$Identity) {
  if (-not $Process -or -not $Identity) { return $false }
  $current = New-PersistedProcessIdentity $Process
  if ($null -eq $current) { return $false }
  return (
    [int]$Identity.Version -eq 1 -and
    [int]$current.Pid -eq [int]$Identity.Pid -and
    [long]$current.CreationTicks -eq [long]$Identity.CreationTicks
  )
}

function Get-ProcessQueryResult([int]$ProcessId) {
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

function Open-ProcessIdentityHandle([object]$ExpectedIdentity) {
  if (-not $ExpectedIdentity) { return $null }
  try {
    if ([int]$ExpectedIdentity.Version -ne 1 -or
      [int]$ExpectedIdentity.Pid -le 0 -or
      [long]$ExpectedIdentity.CreationTicks -le 0) { return $null }
    [int]$processId = $ExpectedIdentity.Pid
    $handle = [CodexFeishu.ProcessNative]::OpenIdentityHandle($processId)
    if ($handle -eq [IntPtr]::Zero) { return $null }
    $keepHandle = $false
    try {
      $nativeTicks = [long][CodexFeishu.ProcessNative]::GetCreationTicks($handle)
      $normalizedTicks = $nativeTicks - ($nativeTicks % 10)
      if ($normalizedTicks -ne [long]$ExpectedIdentity.CreationTicks) { return $null }
      $keepHandle = $true
      return [pscustomobject]@{
        Handle = [IntPtr]$handle
        Pid = $processId
        CreationTicks = $normalizedTicks
      }
    } finally {
      if (-not $keepHandle) {
        [CodexFeishu.ProcessNative]::CloseIdentityHandle($handle) | Out-Null
      }
    }
  } catch {
    return $null
  }
}

function Close-ProcessIdentityHandle([object]$ProcessHandle) {
  if (-not $ProcessHandle) { return $false }
  try {
    $handle = [IntPtr]$ProcessHandle.Handle
    if ($handle -eq [IntPtr]::Zero) { return $true }
    return [CodexFeishu.ProcessNative]::CloseIdentityHandle($handle)
  } catch {
    return $false
  } finally {
    try { $ProcessHandle.Handle = [IntPtr]::Zero } catch {}
  }
}

function Get-ProcessIdentityHandleState([object]$ProcessHandle) {
  if (-not $ProcessHandle) { throw 'Cannot query an empty process identity handle.' }
  try {
    $handle = [IntPtr]$ProcessHandle.Handle
    if ($handle -eq [IntPtr]::Zero) { throw 'The process identity handle is closed.' }
    if ([CodexFeishu.ProcessNative]::IsActive($handle)) { return 'active' }
    return 'exited'
  } catch {
    throw "Could not query the process identity handle state. $($_.Exception.Message)"
  }
}

function Test-ProcessIdentityHandleActive([object]$ProcessHandle) {
  return (Get-ProcessIdentityHandleState $ProcessHandle) -eq 'active'
}

function Stop-ProcessIdentityHandle([object]$ProcessHandle) {
  if (-not $ProcessHandle) { return $false }
  try {
    $handle = [IntPtr]$ProcessHandle.Handle
    if ($handle -eq [IntPtr]::Zero) { return $false }
    if (-not [CodexFeishu.ProcessNative]::TerminateIdentityHandle($handle)) { return $false }
    return [CodexFeishu.ProcessNative]::WaitForExit($handle, 5000)
  } catch {
    return $false
  }
}

function Get-ProcessMarkerFileSnapshot([string]$Path) {
  if ([string]::IsNullOrWhiteSpace($Path)) { return $null }
  try {
    if (-not (Test-Path -LiteralPath $Path)) {
      return [pscustomobject]@{
        Exists = $false
        Bytes = $null
      }
    }
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
    return [pscustomobject]@{
      Exists = $true
      Bytes = [Convert]::ToBase64String([System.IO.File]::ReadAllBytes([System.IO.Path]::GetFullPath($Path)))
    }
  } catch {
    return $null
  }
}

function Test-ProcessMarkerFileSnapshot([string]$Path, [object]$ExpectedSnapshot) {
  if (-not $ExpectedSnapshot) { return $false }
  $currentSnapshot = Get-ProcessMarkerFileSnapshot $Path
  if (-not $currentSnapshot) { return $false }
  if ([bool]$currentSnapshot.Exists -ne [bool]$ExpectedSnapshot.Exists) { return $false }
  if (-not [bool]$currentSnapshot.Exists) { return $true }
  return [string]::Equals(
    [string]$currentSnapshot.Bytes,
    [string]$ExpectedSnapshot.Bytes,
    [System.StringComparison]::Ordinal
  )
}

function Remove-PersistedProcessMarkersIfMatch(
  [string]$PidFile,
  [string]$IdentityFile,
  [object]$ExpectedIdentity,
  [string[]]$AdditionalFiles = @(),
  [object[]]$AdditionalFileSnapshots = @()
) {
  if (-not $ExpectedIdentity) { return $false }
  $files = @($AdditionalFiles)
  $snapshots = @($AdditionalFileSnapshots)
  if ($files.Count -ne $snapshots.Count) { return $false }
  $markerPid = Read-PersistedProcessId $PidFile
  $markerIdentity = Read-PersistedProcessIdentity $IdentityFile
  if ($null -eq $markerPid -or -not $markerIdentity) { return $false }
  if ([int]$markerPid -ne [int]$ExpectedIdentity.Pid -or
    [int]$markerIdentity.Version -ne [int]$ExpectedIdentity.Version -or
    [int]$markerIdentity.Pid -ne [int]$ExpectedIdentity.Pid -or
    [long]$markerIdentity.CreationTicks -ne [long]$ExpectedIdentity.CreationTicks) { return $false }

  for ($index = 0; $index -lt $files.Count; $index++) {
    if ([string]::IsNullOrWhiteSpace($files[$index])) { continue }
    if (-not (Test-ProcessMarkerFileSnapshot $files[$index] $snapshots[$index])) { return $false }
  }

  Remove-Item -LiteralPath $PidFile -Force
  Remove-Item -LiteralPath $IdentityFile -Force
  foreach ($file in $files) {
    if (-not [string]::IsNullOrWhiteSpace($file)) {
      Remove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue
    }
  }
  return $true
}

function Test-ListeningPortOwner([int]$Port, [int]$ProcessId) {
  try {
    $connections = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop)
    $listenerFound = $false
    foreach ($connection in $connections) {
      $listenerFound = $true
      if ([int]$connection.OwningProcess -ne $ProcessId -or
        -not [string]::Equals(
        [string]$connection.LocalAddress,
        '127.0.0.1',
        [System.StringComparison]::OrdinalIgnoreCase
      )) {
        return $false
      }
    }
    return $listenerFound
  } catch {
    try {
      $lines = @(netstat.exe -ano -p tcp 2>$null)
      $listenerFound = $false
      foreach ($line in $lines) {
        $parts = ($line -split '\s+') | Where-Object { $_ -ne '' }
        if ($parts.Count -lt 5 -or $parts[0] -ne 'TCP' -or $parts[3] -ne 'LISTENING') { continue }
        if ($parts[1] -notmatch ':(\d+)$' -or [int]$Matches[1] -ne $Port) { continue }
        $listenerFound = $true
        if ([int]$parts[4] -ne $ProcessId -or $parts[1] -notmatch '^127\.0\.0\.1:\d+$') {
          return $false
        }
      }
      return $listenerFound
    } catch {}
    return $false
  }
}

function Test-ExpectedNodeProcess(
  [int]$ExpectedPid,
  [string]$ExpectedScript,
  [string]$ExpectedExecutable = $null,
  [object]$ExpectedIdentity = $null,
  [int]$Port = 0
) {
  if ($ExpectedPid -le 0) { return $false }
  $query = Get-ProcessQueryResult $ExpectedPid
  if (-not $query.Succeeded -or -not $query.Process) { return $false }
  if ($ExpectedIdentity -and -not (Test-PersistedProcessIdentity $query.Process $ExpectedIdentity)) { return $false }
  if ($ExpectedScript -and -not (Test-NodeScriptProcess $query.Process $ExpectedScript $ExpectedExecutable)) { return $false }
  if ($Port -gt 0 -and -not (Test-ListeningPortOwner $Port $ExpectedPid)) { return $false }
  return $true
}

function Test-NodeScriptProcess(
  [object]$Process,
  [string]$Script,
  [string]$ExpectedExecutable = $null
) {
  if (-not $Process -or [string]::IsNullOrWhiteSpace($Process.CommandLine)) { return $false }
  $executable = [string]$Process.ExecutablePath
  if ([string]::IsNullOrWhiteSpace($executable)) { return $false }
  try {
    if ([System.IO.Path]::GetFileName($executable) -notmatch '(?i)^node(?:\.exe)?$') { return $false }
  } catch {
    return $false
  }
  try {
    $arguments = @([CodexFeishu.ProcessNative]::ParseCommandLine([string]$Process.CommandLine))
  } catch {
    return $false
  }
  if ($arguments.Count -lt 2) { return $false }
  $normalizedExecutable = ($executable -replace '/', '\')
  $commandExecutable = ([string]$arguments[0] -replace '/', '\')
  $expectedScript = ($Script -replace '/', '\')
  $commandScript = ([string]$arguments[1] -replace '/', '\')
  if (-not [string]::IsNullOrWhiteSpace($ExpectedExecutable)) {
    $normalizedExpectedExecutable = ($ExpectedExecutable -replace '/', '\')
    if (-not [string]::Equals(
      $normalizedExecutable,
      $normalizedExpectedExecutable,
      [System.StringComparison]::OrdinalIgnoreCase
    )) {
      return $false
    }
  }
  return (
    [string]::Equals($commandExecutable, $normalizedExecutable, [System.StringComparison]::OrdinalIgnoreCase) -and
    [string]::Equals($commandScript, $expectedScript, [System.StringComparison]::OrdinalIgnoreCase)
  )
}

function Stop-IdentityVerifiedNodeProcess(
  [object]$Process,
  [string]$Script,
  [object]$ExpectedIdentity,
  [string]$ExpectedExecutable = $null
) {
  if (-not $Process -or -not $ExpectedIdentity) { throw 'Cannot stop a process without its persisted identity.' }
  [int]$processId = $ExpectedIdentity.Pid
  if (-not (Test-PersistedProcessIdentity $Process $ExpectedIdentity) -or
    -not (Test-NodeScriptProcess $Process $Script $ExpectedExecutable)) {
    throw "Refusing to stop PID ${processId}: initial process identity did not match."
  }

  $processHandle = Open-ProcessIdentityHandle $ExpectedIdentity
  if (-not $processHandle) {
    try {
      $current = Get-CimInstance Win32_Process -Filter "ProcessId=$processId" -ErrorAction Stop
    } catch {
      throw "Could not query PID ${processId} after its identity handle could not be opened."
    }
    if (-not $current) { return $false }
    throw "Refusing to stop PID ${processId}: exact creation identity could not be held."
  }

  try {
    try {
      $current = Get-CimInstance Win32_Process -Filter "ProcessId=$processId" -ErrorAction Stop
    } catch {
      throw "Could not query PID ${processId} while holding its identity handle."
    }
    if (-not $current) {
      if ((Get-ProcessIdentityHandleState $processHandle) -eq 'exited') { return $false }
      throw "Refusing to stop PID ${processId}: the active process could not be queried."
    }
    if (-not (Test-PersistedProcessIdentity $current $ExpectedIdentity) -or
      -not (Test-NodeScriptProcess $current $Script $ExpectedExecutable)) {
      throw "Refusing to stop PID ${processId}: process identity changed before termination."
    }
    if (-not (Test-ProcessIdentityHandleActive $processHandle)) { return $false }

    if (-not (Stop-ProcessIdentityHandle $processHandle)) {
      $afterStop = Get-ProcessQueryResult $processId
      if (-not $afterStop.Succeeded) {
        throw "Could not confirm whether PID $processId stopped: $($afterStop.Error)"
      }
      if (-not $afterStop.Process) { return $true }
      throw "Could not stop PID $processId"
    }
    return $true
  } finally {
    Close-ProcessIdentityHandle $processHandle | Out-Null
  }
}

function Get-VerifiedCurrentNodeProcess(
  [object]$ObservedProcess,
  [string]$Script,
  [int]$Port = 0,
  [string]$ExpectedExecutable = $null
) {
  $observedIdentity = New-PersistedProcessIdentity $ObservedProcess
  if (-not $observedIdentity) { return $null }
  [int]$processId = $observedIdentity.Pid
  $current = Get-CimInstance Win32_Process -Filter "ProcessId=$processId" -ErrorAction SilentlyContinue
  if (-not $current -or
    -not (Test-PersistedProcessIdentity $current $observedIdentity) -or
    -not (Test-NodeScriptProcess $current $Script $ExpectedExecutable) -or
    ($Port -gt 0 -and -not (Test-ListeningPortOwner $Port $processId))) {
    return $null
  }
  return $current
}
