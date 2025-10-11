#!/usr/bin/env pwsh
<#!
.SYNOPSIS
Builds the Datasetto web client for mobile and syncs the Android Capacitor project.

.DESCRIPTION
Installs npm dependencies (optional), builds the Vite web bundle with production/mobile
endpoints, then copies assets into the Android platform via `npx cap sync android`.

.PARAMETER ForceInstall
Always run `npm install` in both client/ and mobile/ workspaces, even if node_modules exists.

.EXAMPLE
./deploy-mobile.ps1

.EXAMPLE
./deploy-mobile.ps1 -ForceInstall
#>
param(
  [switch]$ForceInstall,
  [switch]$Help
)

if ($Help) {
  Get-Help -Detailed -ErrorAction SilentlyContinue
  if ($LASTEXITCODE -ne 0) {
    Write-Host "Usage: ./deploy-mobile.ps1 [-ForceInstall]" -ForegroundColor Yellow
  }
  exit 0
}

$ErrorActionPreference = 'Stop'

function Resolve-PathSafe {
  param([string]$Path)
  return (Resolve-Path -Path $Path -ErrorAction Stop).ProviderPath
}

$projectRoot = Resolve-PathSafe (Split-Path -Parent $MyInvocation.MyCommand.Path)
$clientDir   = Join-Path $projectRoot 'client'
$mobileDir   = Join-Path $projectRoot 'mobile'
$opsEnv      = Join-Path $projectRoot 'ops/.env'
$clientMobileEnv = Join-Path $clientDir '.env.mobile'
$clientProdEnv   = Join-Path $clientDir '.env.production'

function Assert-Directory {
  param([string]$Path)
  if (-not (Test-Path -Path $Path -PathType Container)) {
    throw "[deploy-mobile] Required directory missing: $Path"
  }
}

Assert-Directory $clientDir
Assert-Directory $mobileDir

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
  throw '[deploy-mobile] npm not found in PATH. Please install Node.js first.'
}

if (-not (Test-Path $opsEnv) -and -not (Test-Path $clientMobileEnv) -and -not (Test-Path $clientProdEnv)) {
  Write-Warning '[deploy-mobile] No environment file detected. Build will fall back to localhost URLs.'
  Write-Host '  Provide endpoints in ops/.env, client/.env.mobile, or client/.env.production to embed production settings.'
}

foreach ($entry in @(
  @{ Dir = $clientDir; Name = 'client' },
  @{ Dir = $mobileDir; Name = 'mobile' }
)) {
  Push-Location $entry.Dir
  try {
    if ($ForceInstall -or -not (Test-Path 'node_modules' -PathType Container)) {
      Write-Host "[deploy-mobile] Installing $($entry.Name) dependencies..." -ForegroundColor Cyan
      npm install
    }
    else {
      Write-Host "[deploy-mobile] $($entry.Name) dependencies already present; skipping npm install." -ForegroundColor DarkGray
    }
  }
  finally {
    Pop-Location
  }
}

Push-Location $mobileDir
try {
  Write-Host '[deploy-mobile] Building web assets for mobile...' -ForegroundColor Cyan
  npm run build:web

  Write-Host '[deploy-mobile] Syncing Android platform...' -ForegroundColor Cyan
  npx cap sync android
}
finally {
  Pop-Location
}

Write-Host ''
Write-Host '[deploy-mobile] Android assets refreshed. Open Android Studio with:' -ForegroundColor Green
Write-Host '  cd mobile; npm run open:android' -ForegroundColor Green
