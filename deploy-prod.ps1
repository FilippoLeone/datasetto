<#
.SYNOPSIS
    Production Deployment Script for Windows
    Automates the setup and deployment of the application using Docker Compose.

.DESCRIPTION
    This script:
    1. Checks for Docker and Docker Compose.
    2. Configures environment variables (creating ops/.env).
    3. Builds and starts the production containers.
    4. Verifies the deployment.

.EXAMPLE
    .\deploy-prod.ps1
#>

$ErrorActionPreference = "Stop"

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  Datasetto Production Deployment (Windows)" -ForegroundColor Cyan
Write-Host "========================================"
Write-Host ""

# 1. Check Prerequisites
Write-Host "[1/4] Checking prerequisites..." -ForegroundColor Yellow
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    Write-Error "Docker is not installed or not in PATH. Please install Docker Desktop."
}
if (-not (Get-Command "docker" -ErrorAction SilentlyContinue)) { 
    # Docker Desktop usually includes compose as 'docker compose'
    Write-Error "Docker Compose is not available."
}

# 2. Configuration
Write-Host "[2/4] Configuring environment..." -ForegroundColor Yellow

$OpsDir = Join-Path $PSScriptRoot "ops"
if (-not (Test-Path $OpsDir)) {
    Write-Error "Directory 'ops' not found. Please run this script from the project root."
}

$EnvFile = Join-Path $OpsDir ".env"
$RootEnvProd = Join-Path $PSScriptRoot ".env.production"

# Function to prompt for input with default
function Read-HostWithDefault {
    param([string]$Prompt, [string]$Default)
    $InputVal = Read-Host "$Prompt [$Default]"
    if ([string]::IsNullOrWhiteSpace($InputVal)) { return $Default }
    return $InputVal
}

# Check if we should use existing .env.production or prompt
if (Test-Path $RootEnvProd) {
    Write-Host "Found .env.production in root." -ForegroundColor Gray
    $UseExisting = Read-HostWithDefault "Use values from .env.production?" "yes"
    
    if ($UseExisting -eq "yes") {
        Copy-Item $RootEnvProd $EnvFile -Force
        Write-Host "Copied .env.production to ops/.env" -ForegroundColor Green
    } else {
        # Fallback to manual config if they say no
        $ManualConfig = $true
    }
} else {
    $ManualConfig = $true
}

if ($ManualConfig) {
    Write-Host "Starting manual configuration..." -ForegroundColor Gray
    
    $Domain = Read-HostWithDefault "Enter Domain (or IP)" "localhost"
    $Email = Read-HostWithDefault "Enter Email for SSL" "admin@localhost"
    
    $Content = @"
NODE_ENV=production
PORT=4000
HOST=0.0.0.0

# URLs
SERVER_URL=https://$Domain
HLS_BASE_URL=https://$Domain/hls
API_BASE_URL=https://$Domain
CORS_ORIGIN=https://$Domain,https://localhost,capacitor://localhost,http://localhost

# Security
PASSWORD_MIN_LENGTH=8
ACCOUNT_SESSION_TTL_MS=86400000

# Resources
MAX_CONNECTIONS_PER_IP=10
MAX_CHANNELS=50
MAX_USERS_PER_CHANNEL=50

# Caddy
DOMAIN=$Domain
LETSENCRYPT_EMAIL=$Email

# TURN (Defaults)
TURN_PORT=3478
TURN_MIN_PORT=49160
TURN_MAX_PORT=49200
TURN_REALM=$Domain
TURN_USERNAME=turnuser
TURN_PASSWORD=$(New-Guid).ToString().Replace("-","")
"@
    
    Set-Content -Path $EnvFile -Value $Content
    Write-Host "Created new .env file at $EnvFile" -ForegroundColor Green
}

# 3. Deployment
Write-Host ""
Write-Host "[3/4] Building and starting containers..." -ForegroundColor Yellow

Set-Location $OpsDir

# Stop existing
docker compose -f docker-compose.prod.yml down --remove-orphans 2>$null

# Build and Start
docker compose -f docker-compose.prod.yml up --build -d

# 4. Verification
Write-Host ""
Write-Host "[4/4] Verifying deployment..." -ForegroundColor Yellow
Start-Sleep -Seconds 10
docker compose -f docker-compose.prod.yml ps

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "Deployment Complete!" -ForegroundColor Green
Write-Host "========================================"
Write-Host ""
Write-Host "App should be accessible at https://localhost (or your domain)"
Write-Host "Note: If using localhost, accept the self-signed certificate warning."
