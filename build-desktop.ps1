<#
.SYNOPSIS
    Datasetto Desktop Release Build Script

.DESCRIPTION
    Builds Datasetto desktop application for various platforms.
    
.PARAMETER Platform
    Target platform: win, linux, mac, or all

.PARAMETER Arch
    Target architecture: x64, arm64, or all

.EXAMPLE
    .\build-desktop.ps1 -Platform win
    .\build-desktop.ps1 -Platform linux -Arch arm64
    .\build-desktop.ps1 -Platform all
#>

param(
    [ValidateSet('win', 'linux', 'mac', 'all', 'current')]
    [string]$Platform = 'current',
    
    [ValidateSet('x64', 'arm64', 'all', 'current')]
    [string]$Arch = 'current'
)

$ErrorActionPreference = 'Stop'

$ScriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$DesktopDir = Join-Path $ScriptRoot 'desktop'
$ReleaseDir = Join-Path $DesktopDir 'release'

function Write-Step {
    param([string]$Message)
    Write-Host ""
    Write-Host "📦 $Message" -ForegroundColor Cyan
    Write-Host ""
}

function Write-Success {
    param([string]$Message)
    Write-Host "✅ $Message" -ForegroundColor Green
}

function Write-Warning {
    param([string]$Message)
    Write-Host "⚠️  $Message" -ForegroundColor Yellow
}

function Test-Command {
    param([string]$Command)
    return $null -ne (Get-Command $Command -ErrorAction SilentlyContinue)
}

# Check prerequisites
Write-Host ""
Write-Host "🚀 Datasetto Desktop Release Builder" -ForegroundColor Magenta
Write-Host "=====================================" -ForegroundColor Magenta
Write-Host ""

Write-Host "Target Platform: $Platform"
Write-Host "Target Architecture: $Arch"
Write-Host ""

# Check Node.js
if (-not (Test-Command 'node')) {
    Write-Error "Node.js is not installed. Please install Node.js first."
    exit 1
}

# Check npm
if (-not (Test-Command 'npm')) {
    Write-Error "npm is not installed. Please install npm first."
    exit 1
}

# Check for cross-compilation requirements
if ($Platform -eq 'linux' -and $env:OS -eq 'Windows_NT') {
    Write-Warning "Building Linux on Windows may require WSL or additional tools"
}

if ($Platform -eq 'mac' -and $env:OS -eq 'Windows_NT') {
    Write-Warning "Building macOS on Windows is not supported. Use a Mac or CI/CD."
    if ($Platform -eq 'mac') {
        exit 1
    }
}

# Navigate to desktop directory
Push-Location $DesktopDir

try {
    # Install dependencies if needed
    if (-not (Test-Path (Join-Path $DesktopDir 'node_modules'))) {
        Write-Step "Installing desktop dependencies..."
        npm install
    }
    
    # Install client dependencies if needed
    $ClientDir = Join-Path $ScriptRoot 'client'
    if (-not (Test-Path (Join-Path $ClientDir 'node_modules'))) {
        Write-Step "Installing client dependencies..."
        Push-Location $ClientDir
        npm install
        Pop-Location
    }
    
    # Build using the release script
    Write-Step "Starting build process..."
    
    $args = @()
    if ($Platform -ne 'current') {
        $args += '--platform', $Platform
    }
    if ($Arch -ne 'current') {
        $args += '--arch', $Arch
    }
    
    node ./scripts/build-release.mjs @args
    
    if ($LASTEXITCODE -ne 0) {
        throw "Build failed with exit code $LASTEXITCODE"
    }
    
    Write-Host ""
    Write-Success "Build completed successfully!"
    Write-Host ""
    
    # List generated files
    if (Test-Path $ReleaseDir) {
        Write-Host "📁 Generated artifacts:" -ForegroundColor Cyan
        Write-Host ""
        
        Get-ChildItem $ReleaseDir -File | Where-Object {
            $_.Name -notmatch '\.(yml|yaml|blockmap)$' -and 
            $_.Name -ne 'builds.json'
        } | ForEach-Object {
            $size = "{0:N2} MB" -f ($_.Length / 1MB)
            Write-Host "   • $($_.Name) ($size)" -ForegroundColor White
        }
        
        Write-Host ""
        Write-Host "📄 Release directory: $ReleaseDir" -ForegroundColor Gray
    }
    
} catch {
    Write-Host ""
    Write-Host "❌ Build failed: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
} finally {
    Pop-Location
}
