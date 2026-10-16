# Installs your SSH public key on a fresh VPS using the password from the provider's
# delivery email (typed once, interactively). Afterwards ssh works without a password.
#   .\ops\vps\install-ssh-key.ps1 -Server 57.128.227.59 -User debian
param(
  [Parameter(Mandatory = $true)] [string] $Server,
  [string] $User = 'debian',
  [string] $KeyFile = (Join-Path $env:USERPROFILE '.ssh\id_ed25519.pub')
)
if (-not (Test-Path $KeyFile)) { throw "public key not found: $KeyFile (run ssh-keygen -t ed25519 first)" }
$key = (Get-Content $KeyFile -Raw).Trim()
$remote = "mkdir -p ~/.ssh && chmod 700 ~/.ssh && grep -qF '$key' ~/.ssh/authorized_keys 2>/dev/null || echo '$key' >> ~/.ssh/authorized_keys; chmod 600 ~/.ssh/authorized_keys && echo 'key installed for' `$(whoami)"
Write-Host "Connecting to $User@$Server; enter the VPS password when asked."
ssh -o StrictHostKeyChecking=accept-new "$User@$Server" $remote
