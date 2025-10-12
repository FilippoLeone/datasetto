# Version Bump Script (PowerShell)
# Usage: .\bump-version.ps1 0.2.0

param(
    [Parameter(Mandatory=$true)]
    [string]$NewVersion
)

Write-Host "🔄 Bumping version to $NewVersion..." -ForegroundColor Cyan

function Update-PackageVersion {
    param($FilePath)
    
    if (Test-Path $FilePath) {
        Write-Host "  → Updating $FilePath" -ForegroundColor Gray
        $content = Get-Content $FilePath -Raw
        $content = $content -replace '"version":\s*"[^"]*"', "`"version`": `"$NewVersion`""
        Set-Content -Path $FilePath -Value $content -NoNewline
    }
}

# Update all package.json files
Update-PackageVersion "client/package.json"
Update-PackageVersion "desktop/package.json"
Update-PackageVersion "mobile/package.json"
Update-PackageVersion "server/package.json"
Update-PackageVersion "ops/package.json"

Write-Host "✅ Version bumped to $NewVersion" -ForegroundColor Green
Write-Host ""
Write-Host "Next steps:" -ForegroundColor Yellow
Write-Host "  1. Review changes: git diff"
Write-Host "  2. Commit: git commit -am 'Bump version to $NewVersion'"
Write-Host "  3. Tag: git tag -a v$NewVersion -m 'Release version $NewVersion'"
Write-Host "  4. Push: git push origin main --tags"
Write-Host "  5. Create release on GitHub"
