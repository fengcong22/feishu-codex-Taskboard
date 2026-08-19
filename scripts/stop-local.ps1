$ErrorActionPreference = 'Stop'

$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$runtime = Join-Path $root '.runtime'
$taskboardRoot = if ($env:CODEX_TASKBOARD_ROOT) { (Resolve-Path $env:CODEX_TASKBOARD_ROOT).Path } else { 'D:\codex\dashi-taskboard' }
$targets = @(
  @{ Name = 'taskboard'; File = Join-Path $runtime 'taskboard.pid'; Match = (Join-Path $taskboardRoot 'server\index.mjs') },
  @{ Name = 'bridge'; File = Join-Path $runtime 'bridge.pid'; Match = (Join-Path $root 'src\index.mjs') }
)
foreach ($target in $targets) {
  if (-not (Test-Path $target.File)) { continue }
  $processId = [int](Get-Content $target.File -Raw)
  $process = Get-CimInstance Win32_Process -Filter "ProcessId=$processId" -ErrorAction SilentlyContinue
  $commandLine = if ($process) { ($process.CommandLine -replace '/', '\\') } else { '' }
  $expected = $target.Match -replace '/', '\\'
  if ($process -and $commandLine -like "*$expected*") {
    & taskkill.exe /PID $processId /T /F | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Could not stop $($target.Name) (PID $processId)" }
    Write-Host "Stopped $($target.Name) (PID $processId)"
  } else {
    Write-Host "Skipped $($target.Name): PID command line did not match"
  }
  Remove-Item -LiteralPath $target.File -Force
}
