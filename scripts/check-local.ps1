param(
  [switch]$RequireFeishu
)

$ErrorActionPreference = 'Stop'

$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$config = if ($env:BRIDGE_CONFIG) { $env:BRIDGE_CONFIG } else { Join-Path $root 'config\bridge.local.json' }
$taskboardUrl = 'http://127.0.0.1:47823/api/meta'
$bridgeUrl = 'http://127.0.0.1:47824/health'

$nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $nodeCommand) { $nodeCommand = Get-Command node -ErrorAction SilentlyContinue }
if (-not $nodeCommand) { throw 'Node.js was not found. Install Node.js >= 22.5.' }
$node = $nodeCommand.Source

$nodeVersionOutput = (& $node --version 2>$null).Trim()
if ($LASTEXITCODE -ne 0 -or $nodeVersionOutput -notmatch '^v(\d+)\.(\d+)\.(\d+)') {
  throw 'Could not determine the Node.js version.'
}
$nodeMajor = [int]$Matches[1]
$nodeMinor = [int]$Matches[2]
if ($nodeMajor -lt 22 -or ($nodeMajor -eq 22 -and $nodeMinor -lt 5)) {
  throw "Node.js >= 22.5 is required (found $nodeVersionOutput)."
}

if (-not (Test-Path -LiteralPath $config -PathType Leaf)) {
  throw 'Local config is missing. Create config/bridge.local.json from config/bridge.example.json.'
}

$validationCode = @'
import { loadConfig } from "./src/config.mjs";
const config = await loadConfig(process.argv[1]);
console.log(JSON.stringify({ tables: config.tables.length, packages: Object.keys(config.packages).length }));
'@
$configSummaryOutput = $null
Push-Location $root
try {
  $configSummaryOutput = & $node --input-type=module -e $validationCode $config 2>&1
  $configExitCode = $LASTEXITCODE
} finally {
  Pop-Location
}
if ($configExitCode -ne 0) {
  throw 'Local config failed validation. Check config/bridge.local.json.'
}
try {
  $configSummary = ($configSummaryOutput -join "`n") | ConvertFrom-Json
} catch {
  throw 'Local config validation returned an unreadable result.'
}

function Get-JsonEndpoint([string]$Name, [string]$Url) {
  try {
    $value = Invoke-RestMethod -Method Get -Uri $Url -TimeoutSec 3
  } catch {
    throw "$Name is unavailable at $Url."
  }
  if ($null -eq $value) { throw "$Name returned an empty response." }
  return $value
}

$taskboard = Get-JsonEndpoint 'Taskboard' $taskboardUrl
$bridge = Get-JsonEndpoint 'Bridge' $bridgeUrl
if ($bridge.ok -ne $true) { throw 'Bridge health check returned ok=false.' }

$listenerState = [string]$bridge.feishuListener
if ([string]::IsNullOrWhiteSpace($listenerState)) { $listenerState = 'unknown' }
if ($RequireFeishu -and $listenerState -ne 'connected') {
  throw "Feishu listener is not connected (state: $listenerState)."
}

Write-Host "Node: $nodeVersionOutput"
Write-Host "Config: ok (tables=$($configSummary.tables), packages=$($configSummary.packages))"
Write-Host "Taskboard: ok ($taskboardUrl)"
Write-Host "Bridge: ok ($bridgeUrl)"
Write-Host "Feishu listener: $listenerState"
if (-not $RequireFeishu -and $listenerState -ne 'connected') {
  Write-Warning 'Feishu listener is not connected; rerun with -RequireFeishu when real events are required.'
}
Write-Host 'Local stack check passed.'
exit 0
