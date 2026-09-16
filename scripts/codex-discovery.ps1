# Shared, read-only Windows CLI discovery. Dot-sourcing this file starts no process.
function Get-CodexVendorCandidates {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)]
    [string]$NpmRoot,
    [string]$Architecture = $null
  )

  $reportedArchitecture = $Architecture
  if ([string]::IsNullOrWhiteSpace($reportedArchitecture)) {
    $reportedArchitecture = [string]$env:PROCESSOR_ARCHITECTURE
    if ($reportedArchitecture -match '^(?i)x86$' -and
      -not [string]::IsNullOrWhiteSpace($env:PROCESSOR_ARCHITEW6432)) {
      $reportedArchitecture = [string]$env:PROCESSOR_ARCHITEW6432
    }
  }
  $normalizedArchitecture = switch -Regex ($reportedArchitecture.Trim().ToLowerInvariant()) {
    '^(arm64|aarch64)$' { 'arm64'; break }
    '^(amd64|x64|x86_64)$' { 'x64'; break }
    default { $null; break }
  }
  if ([string]::IsNullOrWhiteSpace($normalizedArchitecture)) { return @() }
  if ($normalizedArchitecture -eq 'arm64') {
    return @((Join-Path $NpmRoot '@openai\codex-win32-arm64\vendor\aarch64-pc-windows-msvc\bin\codex.exe'))
  }
  return @((Join-Path $NpmRoot '@openai\codex-win32-x64\vendor\x86_64-pc-windows-msvc\bin\codex.exe'))
}

function Resolve-CodexDiscoveryFile([string]$Path) {
  if ([string]::IsNullOrWhiteSpace($Path)) { return $null }
  try {
    $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    if ($item.PSProvider.Name -ne 'FileSystem' -or $item.PSIsContainer) { return $null }
    return [System.IO.Path]::GetFullPath([string]$item.FullName)
  } catch { return $null }
}

function ConvertTo-CodexDiscoveryArgument([string]$Argument) {
  # Windows CommandLineToArgvW quoting, used without cmd.exe or a PowerShell shell.
  $escaped = [regex]::Replace($Argument, '(\\*)"', '$1$1\"')
  $escaped = [regex]::Replace($escaped, '(\\+)$', '$1$1')
  return '"' + $escaped + '"'
}

function Invoke-CodexDiscoveryProcess {
  param(
    [string]$Executable,
    [string[]]$Arguments,
    [int]$TimeoutMs
  )

  try {
    if ($null -eq ('CodexDiscovery.NativeProbe' -as [type])) {
      # Suspend before assigning the private job: no candidate instruction can run
      # or spawn an uncontained descendant. Compilation failure is fail-closed.
      Add-Type -TypeDefinition @'
using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
namespace CodexDiscovery {
  public sealed class ProbeResult {
    public int ExitCode;
    public string Stdout;
    public string Stderr;
  }
  public static class NativeProbe {
    [StructLayout(LayoutKind.Sequential)] struct SecurityAttributes {
      public int Length; public IntPtr Descriptor; public int Inherit;
    }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct StartupInfo {
      public int Size; public string Reserved; public string Desktop; public string Title;
      public uint X, Y, XSize, YSize, XCountChars, YCountChars, FillAttribute, Flags;
      public short ShowWindow, ReservedSize; public IntPtr ReservedBytes, Input, Output, Error;
    }
    [StructLayout(LayoutKind.Sequential)] struct StartupInfoEx {
      public StartupInfo Startup; public IntPtr Attributes;
    }
    [StructLayout(LayoutKind.Sequential)] struct ProcessInfo {
      public IntPtr Process, Thread; public uint ProcessId, ThreadId;
    }
    [StructLayout(LayoutKind.Sequential)] struct BasicLimit {
      public long ProcessTime, JobTime; public uint Flags;
      public UIntPtr MinWorkingSet, MaxWorkingSet; public uint ActiveProcessLimit;
      public UIntPtr Affinity; public uint Priority, Scheduling;
    }
    [StructLayout(LayoutKind.Sequential)] struct IoCounters {
      public ulong ReadOperations, WriteOperations, OtherOperations, ReadBytes, WriteBytes, OtherBytes;
    }
    [StructLayout(LayoutKind.Sequential)] struct ExtendedLimit {
      public BasicLimit Basic; public IoCounters Io;
      public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
    }
    [StructLayout(LayoutKind.Sequential)] struct JobAccounting {
      public long UserTime, KernelTime, PeriodUserTime, PeriodKernelTime;
      public uint PageFaults, TotalProcesses, ActiveProcesses, TerminatedProcesses;
    }
    [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimit limits, uint size);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job, int kind, out JobAccounting accounting, uint size, IntPtr resultSize);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateJobObject(IntPtr job, uint code);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool CreatePipe(out IntPtr read, out IntPtr write, ref SecurityAttributes attributes, uint size);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, uint flags, ref IntPtr size);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returned);
    [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcess(string application, StringBuilder command, IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint flags, IntPtr environment, string directory, ref StartupInfoEx startup, out ProcessInfo process);
    [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr process, uint code);
    [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool PeekNamedPipe(IntPtr pipe, IntPtr buffer, uint size, IntPtr read, out uint available, IntPtr remaining);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool ReadFile(IntPtr file, byte[] bytes, uint length, out uint read, IntPtr overlapped);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    static void Close(ref IntPtr handle) {
      if (handle != IntPtr.Zero) { CloseHandle(handle); handle = IntPtr.Zero; }
    }
    static void Require(bool success) { if (!success) throw new InvalidOperationException(); }
    static void Drain(IntPtr pipe, MemoryStream output) {
      uint available;
      if (!PeekNamedPipe(pipe, IntPtr.Zero, 0, IntPtr.Zero, out available, IntPtr.Zero)) {
        if (Marshal.GetLastWin32Error() == 109) return; // All writers closed.
        throw new InvalidOperationException();
      }
      if (available == 0) return;
      if (output.Length + available > 32768) throw new InvalidOperationException();
      byte[] bytes = new byte[Math.Min(available, 4096u)];
      uint count;
      Require(ReadFile(pipe, bytes, (uint)bytes.Length, out count, IntPtr.Zero));
      output.Write(bytes, 0, (int)count);
    }
    static bool EmptyJob(IntPtr job, int timeoutMs) {
      Stopwatch clock = Stopwatch.StartNew();
      do {
        JobAccounting accounting;
        if (!QueryInformationJobObject(job, 1, out accounting, (uint)Marshal.SizeOf(typeof(JobAccounting)), IntPtr.Zero)) return false;
        if (accounting.ActiveProcesses == 0) return true;
        Thread.Sleep(5);
      } while (clock.ElapsedMilliseconds < timeoutMs);
      return false;
    }
    public static ProbeResult Run(string executable, string arguments, int timeoutMs) {
      IntPtr job=IntPtr.Zero, inputRead=IntPtr.Zero, inputWrite=IntPtr.Zero;
      IntPtr outputRead=IntPtr.Zero, outputWrite=IntPtr.Zero, errorRead=IntPtr.Zero, errorWrite=IntPtr.Zero;
      IntPtr attributes=IntPtr.Zero, handles=IntPtr.Zero;
      bool initialized=false, assigned=false;
      ProcessInfo process = new ProcessInfo();
      try {
        job = CreateJobObject(IntPtr.Zero, null);
        Require(job != IntPtr.Zero);
        ExtendedLimit limits = new ExtendedLimit();
        limits.Basic.Flags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE; no breakaway.
        Require(SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(ExtendedLimit))));
        SecurityAttributes security = new SecurityAttributes();
        security.Length = Marshal.SizeOf(typeof(SecurityAttributes)); security.Inherit = 1;
        Require(CreatePipe(out inputRead, out inputWrite, ref security, 0));
        Require(CreatePipe(out outputRead, out outputWrite, ref security, 0));
        Require(CreatePipe(out errorRead, out errorWrite, ref security, 0));
        Require(SetHandleInformation(inputWrite, 1, 0));
        Require(SetHandleInformation(outputRead, 1, 0));
        Require(SetHandleInformation(errorRead, 1, 0));
        // Restrict inheritance to these three pipes, including when the launcher
        // itself has unrelated inheritable handles from Codex or a terminal.
        IntPtr attributeSize = IntPtr.Zero;
        InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref attributeSize);
        attributes = Marshal.AllocHGlobal(attributeSize);
        Require(InitializeProcThreadAttributeList(attributes, 1, 0, ref attributeSize)); initialized=true;
        handles = Marshal.AllocHGlobal(IntPtr.Size * 3);
        Marshal.WriteIntPtr(handles, 0, inputRead);
        Marshal.WriteIntPtr(handles, IntPtr.Size, outputWrite);
        Marshal.WriteIntPtr(handles, IntPtr.Size * 2, errorWrite);
        Require(UpdateProcThreadAttribute(attributes, 0, new IntPtr(0x20002), handles, new IntPtr(IntPtr.Size * 3), IntPtr.Zero, IntPtr.Zero));
        StartupInfoEx startup = new StartupInfoEx();
        startup.Startup.Size = Marshal.SizeOf(typeof(StartupInfoEx));
        startup.Startup.Flags = 0x100; // STARTF_USESTDHANDLES.
        startup.Startup.Input=inputRead; startup.Startup.Output=outputWrite; startup.Startup.Error=errorWrite;
        startup.Attributes=attributes;
        StringBuilder command = new StringBuilder("\"" + executable + "\" " + arguments);
        Require(CreateProcess(executable, command, IntPtr.Zero, IntPtr.Zero, true,
          0x08000000 | 0x00080000 | 0x00000004, IntPtr.Zero, null, ref startup, out process));
        Require(AssignProcessToJobObject(job, process.Process)); assigned=true;
        Close(ref inputRead); Close(ref inputWrite); Close(ref outputWrite); Close(ref errorWrite);
        Require(ResumeThread(process.Thread) != UInt32.MaxValue);
        Close(ref process.Thread);
        Stopwatch deadline = Stopwatch.StartNew();
        using (MemoryStream stdout = new MemoryStream())
        using (MemoryStream stderr = new MemoryStream()) {
          while (WaitForSingleObject(process.Process, 0) == 258) {
            if (deadline.ElapsedMilliseconds >= timeoutMs) return null;
            Drain(outputRead, stdout); Drain(errorRead, stderr);
            Thread.Sleep(5);
          }
          uint exitCode;
          Require(GetExitCodeProcess(process.Process, out exitCode));
          // Even successful wrappers may leave a child holding stdout open.
          // End the complete private job before draining the final buffered data.
          Require(TerminateJobObject(job, 1));
          Require(EmptyJob(job, 500));
          for (int pass=0; pass<9; pass++) { Drain(outputRead, stdout); Drain(errorRead, stderr); }
          return new ProbeResult { ExitCode=(int)exitCode, Stdout=Encoding.UTF8.GetString(stdout.ToArray()), Stderr=Encoding.UTF8.GetString(stderr.ToArray()) };
        }
      } catch { return null; }
      finally {
        if (assigned) { TerminateJobObject(job, 1); EmptyJob(job, 500); }
        else if (process.Process != IntPtr.Zero) { TerminateProcess(process.Process, 1); WaitForSingleObject(process.Process, 500); }
        Close(ref job); Close(ref process.Thread); Close(ref process.Process);
        Close(ref inputRead); Close(ref inputWrite); Close(ref outputRead); Close(ref outputWrite); Close(ref errorRead); Close(ref errorWrite);
        if (initialized) DeleteProcThreadAttributeList(attributes);
        if (attributes != IntPtr.Zero) Marshal.FreeHGlobal(attributes);
        if (handles != IntPtr.Zero) Marshal.FreeHGlobal(handles);
      }
    }
  }
}
'@ -ErrorAction Stop
    }
    $argumentLine = (@($Arguments | ForEach-Object { ConvertTo-CodexDiscoveryArgument $_ }) -join ' ')
    return [CodexDiscovery.NativeProbe]::Run($Executable, $argumentLine, $TimeoutMs)
  } catch { return $null }
}

function Test-CodexDiscoveryExecutable([string]$Executable, [int]$TimeoutMs) {
  if ([System.IO.Path]::GetExtension($Executable) -ine '.exe') { return $false }
  $result = Invoke-CodexDiscoveryProcess -Executable $Executable -Arguments @('--version') -TimeoutMs $TimeoutMs
  if ($null -eq $result -or $result.ExitCode -ne 0) { return $false }
  return $result.Stdout.Trim() -cmatch '^codex-cli [0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$'
}

function Get-CodexDesktopCandidates {
  if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) { return @() }
  try {
    $binRoot = Join-Path $env:LOCALAPPDATA 'OpenAI\Codex\bin'
    if (-not (Test-Path -LiteralPath $binRoot -PathType Container)) { return @() }
    $files = @(Get-ChildItem -LiteralPath $binRoot -Directory -Force -ErrorAction Stop | ForEach-Object {
      $candidate = Join-Path $_.FullName 'codex.exe'
      if (Test-Path -LiteralPath $candidate -PathType Leaf) {
        Get-Item -LiteralPath $candidate -Force -ErrorAction Stop
      }
    })
    return @($files | Sort-Object @{ Expression = 'LastWriteTimeUtc'; Descending = $true }, @{ Expression = 'FullName'; Ascending = $true } | ForEach-Object { $_.FullName })
  } catch { return @() }
}

function Get-CodexNpmGlobalCandidates([string]$NpmCommand, [int]$TimeoutMs) {
  try {
    if ([string]::IsNullOrWhiteSpace($NpmCommand)) {
      $command = Get-Command npm.cmd -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
      if ($command) { $NpmCommand = $command.Source }
    }
    $npmFile = Resolve-CodexDiscoveryFile $NpmCommand
    if ([string]::IsNullOrWhiteSpace($npmFile) -or [System.IO.Path]::GetFileName($npmFile) -ine 'npm.cmd') { return @() }
    $npmDirectory = Split-Path $npmFile -Parent
    $npmCli = Resolve-CodexDiscoveryFile (Join-Path $npmDirectory 'node_modules\npm\bin\npm-cli.js')
    if ([string]::IsNullOrWhiteSpace($npmCli)) { return @() }
    $node = Resolve-CodexDiscoveryFile (Join-Path $npmDirectory 'node.exe')
    if ([string]::IsNullOrWhiteSpace($node)) {
      $nodeCommand = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
      if ($nodeCommand) { $node = Resolve-CodexDiscoveryFile $nodeCommand.Source }
    }
    if ([string]::IsNullOrWhiteSpace($node)) { return @() }
    # Root lookup must not create npm cache/log directories or contact its update
    # notifier. Keep user prefix configuration, while disabling these side effects.
    $result = Invoke-CodexDiscoveryProcess -Executable $node -Arguments @(
      $npmCli, 'root', '--global', '--logs-max=0', '--timing=false',
      '--update-notifier=false', '--offline', '--cache', $npmDirectory
    ) -TimeoutMs $TimeoutMs
    if ($null -eq $result -or $result.ExitCode -ne 0) { return @() }
    $globalRoot = $result.Stdout.Trim()
    if ($globalRoot -match '[\r\n]' -or -not [System.IO.Path]::IsPathRooted($globalRoot)) { return @() }
    $vendorRoot = Join-Path $globalRoot '@openai\codex\node_modules'
    return @(Get-CodexVendorCandidates -NpmRoot $vendorRoot)
  } catch { return @() }
}

function Resolve-CodexExecutable {
  [CmdletBinding()]
  param(
    [string]$ExplicitExecutable = $null,
    [string[]]$Candidates = $null,
    [string]$NpmCommand = $null,
    [ValidateRange(1, 60000)]
    [int]$ProbeTimeoutMs = 3000
  )

  $seen = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)
  $tryCandidate = {
    param([string]$Path)
    $file = Resolve-CodexDiscoveryFile $Path
    if ([string]::IsNullOrWhiteSpace($file) -or -not $seen.Add($file)) { return $null }
    if (Test-CodexDiscoveryExecutable -Executable $file -TimeoutMs $ProbeTimeoutMs) { return $file }
    return $null
  }

  if (-not [string]::IsNullOrWhiteSpace($ExplicitExecutable)) {
    $resolvedExplicit = & $tryCandidate $ExplicitExecutable
    if (-not [string]::IsNullOrWhiteSpace($resolvedExplicit)) { return $resolvedExplicit }
    if ($null -eq (Resolve-CodexDiscoveryFile $ExplicitExecutable)) {
      Write-Warning 'Configured CODEX_EXECUTABLE was not found; continuing with automatic Codex discovery.'
    } else {
      Write-Warning 'Configured CODEX_EXECUTABLE did not pass the Codex CLI version check; continuing with automatic Codex discovery.'
    }
  }
  $pathCommands = @(Get-Command codex.exe -All -CommandType Application -ErrorAction SilentlyContinue)
  foreach ($command in $pathCommands) {
    $resolved = & $tryCandidate $command.Source
    if (-not [string]::IsNullOrWhiteSpace($resolved)) { return $resolved }
  }
  if ($null -ne $Candidates) {
    foreach ($candidate in $Candidates) {
      $resolved = & $tryCandidate $candidate
      if (-not [string]::IsNullOrWhiteSpace($resolved)) { return $resolved }
    }
    return $null
  }
  foreach ($candidate in @(Get-CodexDesktopCandidates)) {
    $resolved = & $tryCandidate $candidate
    if (-not [string]::IsNullOrWhiteSpace($resolved)) { return $resolved }
  }
  foreach ($candidate in @(Get-CodexNpmGlobalCandidates -NpmCommand $NpmCommand -TimeoutMs $ProbeTimeoutMs)) {
    $resolved = & $tryCandidate $candidate
    if (-not [string]::IsNullOrWhiteSpace($resolved)) { return $resolved }
  }
  if (-not [string]::IsNullOrWhiteSpace($env:APPDATA)) {
    $npmRoot = Join-Path $env:APPDATA 'npm\node_modules\@openai\codex\node_modules'
    foreach ($candidate in @(Get-CodexVendorCandidates -NpmRoot $npmRoot)) {
      $resolved = & $tryCandidate $candidate
      if (-not [string]::IsNullOrWhiteSpace($resolved)) { return $resolved }
    }
  }
  return $null
}
