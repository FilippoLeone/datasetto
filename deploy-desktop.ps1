Param(
  [switch]$SkipInstall
)

$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$clientDir = Join-Path $projectRoot 'client'
$desktopDir = Join-Path $projectRoot 'desktop'

function Require-Command {
  param([string]$Command)
  if (-not (Get-Command $Command -ErrorAction SilentlyContinue)) {
    Write-Error "[deploy-desktop] Command '$Command' not found in PATH." -ErrorAction Stop
  }
}

function Get-FirstNonEmptyValue {
  param([string[]]$Values)
  foreach ($value in $Values) {
    if (-not [string]::IsNullOrWhiteSpace($value)) {
      return $value.Trim()
    }
  }
  return $null
}

function Get-RtmpFromServer {
  param([string]$ServerUrl)
  if (-not [string]::IsNullOrWhiteSpace($ServerUrl)) {
    $uri = $null
    if ([Uri]::TryCreate($ServerUrl, [UriKind]::Absolute, [ref]$uri)) {
      return "rtmp://$($uri.Host):1935/live"
    }
  }
  return 'rtmp://localhost:1935/live'
}

Require-Command npm

if (-not (Test-Path $clientDir) -or -not (Test-Path $desktopDir)) {
  Write-Error '[deploy-desktop] client/ or desktop/ directory not found.' -ErrorAction Stop
}

Push-Location $clientDir
if (-not $SkipInstall -and -not (Test-Path 'node_modules')) {
  Write-Host '[deploy-desktop] Installing client dependencies...'
  npm install
}

Write-Host '[deploy-desktop] Building web client...'
$previousTarget = $env:VITE_BUILD_TARGET
$env:VITE_BUILD_TARGET = 'desktop'
npm run build
if ($null -eq $previousTarget) {
  Remove-Item Env:VITE_BUILD_TARGET -ErrorAction SilentlyContinue
} else {
  $env:VITE_BUILD_TARGET = $previousTarget
}
Pop-Location

Push-Location $desktopDir
if (-not $SkipInstall -and -not (Test-Path 'node_modules')) {
  Write-Host '[deploy-desktop] Installing desktop dependencies...'
  npm install
}

# Generate runtime config from ops/.env if it exists
$opsEnv = Join-Path $projectRoot 'ops/.env'
$runtimeConfigPath = Join-Path $desktopDir 'resources/runtime-config.json'
if (Test-Path $opsEnv) {
  Write-Host '[deploy-desktop] Generating runtime-config.json from ops/.env...'
  
  $opsContent = Get-Content $opsEnv -Raw
  $defaultServerUrl = Get-FirstNonEmptyValue @(
    $env:DATASETTO_SERVER_URL,
    $env:VITE_SERVER_URL,
    'http://localhost:4000'
  )
  $serverUrl = if ($opsContent -match '(?m)^SERVER_URL=(.+)$') { $Matches[1].Trim() } else { $defaultServerUrl }
  if (-not $serverUrl) {
    $serverUrl = 'http://localhost:4000'
  }

  $defaultHlsUrl = Get-FirstNonEmptyValue @(
    $env:DATASETTO_HLS_BASE_URL,
    $env:VITE_HLS_BASE_URL
  )
  if (-not $defaultHlsUrl) {
    $defaultHlsUrl = "$($serverUrl.TrimEnd('/'))/hls"
  }
  $hlsUrl = if ($opsContent -match '(?m)^HLS_BASE_URL=(.+)$') { $Matches[1].Trim() } else { $defaultHlsUrl }

  $defaultRtmpUrl = Get-FirstNonEmptyValue @(
    $env:DATASETTO_RTMP_SERVER_URL,
    $env:VITE_RTMP_SERVER_URL
  )
  if (-not $defaultRtmpUrl) {
    $defaultRtmpUrl = Get-RtmpFromServer $serverUrl
  }
  $rtmpUrl = if ($opsContent -match '(?m)^RTMP_SERVER_URL=(.+)$') { $Matches[1].Trim() } else { $defaultRtmpUrl }
  
  @"
{
  "serverUrl": "$serverUrl",
  "apiBaseUrl": "$serverUrl",
  "hlsBaseUrl": "$hlsUrl",
  "rtmpServerUrl": "$rtmpUrl"
}
"@ | Set-Content -Path $runtimeConfigPath -NoNewline
  
  Write-Host "[deploy-desktop] Desktop runtime config: $serverUrl"
}

Write-Host '[deploy-desktop] Copying client build into renderer/'
node scripts/copy-dist.mjs

Write-Host '[deploy-desktop] Packaging Electron application...'
npm run build
Pop-Location

Write-Host '[deploy-desktop] Done. Installers available under desktop/release/'
