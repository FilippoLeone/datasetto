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

Write-Host '[deploy-desktop] Copying client build into renderer/'
node scripts/copy-dist.mjs

Write-Host '[deploy-desktop] Packaging Electron application...'
npm run build
Pop-Location

Write-Host '[deploy-desktop] Done. Installers available under desktop/release/'
