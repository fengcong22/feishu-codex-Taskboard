[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$EventId,

  [Parameter(Mandatory = $true)]
  [string]$RunId,

  [Parameter(Mandatory = $true)]
  [string]$DeliveryId,

  [Parameter(Mandatory = $true)]
  [string]$ArtifactId,

  [Parameter(Mandatory = $true)]
  [string]$Sha256,

  [Parameter(Mandatory = $true)]
  [long]$Bytes
)

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$configFile = if ($env:BRIDGE_CONFIG) { $env:BRIDGE_CONFIG } else { Join-Path $root 'config\bridge.local.json' }
if (-not (Test-Path -LiteralPath $configFile -PathType Leaf)) {
  throw 'Bridge config is missing.'
}

$config = Get-Content -LiteralPath $configFile -Raw | ConvertFrom-Json
$bridgePort = 0
if ($config.host -ne '127.0.0.1' -or -not [int]::TryParse([string]$config.port, [ref]$bridgePort) -or
  $bridgePort -lt 1 -or $bridgePort -gt 65535) {
  throw 'Bridge config must use a valid loopback host and port.'
}
if ($Bytes -lt 1 -or $Sha256 -cnotmatch '^[a-f0-9]{64}$') {
  throw 'A valid delivered MP4 hash and byte count are required.'
}

$body = @{
  eventId = $EventId
  expectedSource = @{
    runId = $RunId
    deliveryId = $DeliveryId
    artifactId = $ArtifactId
    sha256 = $Sha256
    bytes = $Bytes
  }
} | ConvertTo-Json -Depth 5 -Compress

$uri = "http://127.0.0.1:$bridgePort/api/local/bridge/vm/final-archive-dead-letter/retry"
$result = Invoke-RestMethod -Method Post -Uri $uri -TimeoutSec 10 `
  -ContentType 'application/json; charset=utf-8' `
  -Headers @{ 'x-feishu-bridge-client' = 'local-operator' } `
  -Body $body

Write-Host "Archive retry accepted: event=$($result.eventId) state=$($result.deliveryState) attempts=$($result.attempts)"
