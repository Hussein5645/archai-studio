param(
    [string]$Dotnet = 'dotnet',
    [ValidateSet('2024','2025','2026','2027')][string[]]$Versions = @('2024','2025','2026','2027'),
    [switch]$UseApiPackages,
    [string]$Version = '0.5.3-beta.1'
)
$ErrorActionPreference = 'Stop'
if ($Version -notmatch '^[0-9A-Za-z.-]+$') { throw 'Version must contain only letters, digits, dots and hyphens.' }
$root = $PSScriptRoot
$release = Join-Path $root "artifacts/releases/$Version-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
$upload = Join-Path $release 'cloudflare-upload'
New-Item -ItemType Directory -Force -Path $upload | Out-Null
$packages = @()
foreach ($year in $Versions) {
    $arguments = @('build', (Join-Path $root 'Archai.Revit/Archai.Revit.csproj'), '-c', 'Release', "-p:RevitVersion=$year", '--nologo', '-v:q')
    if ($UseApiPackages) { $arguments += '-p:UseApiPackages=true' }
    & $Dotnet @arguments
    if ($LASTEXITCODE -ne 0) { throw "Revit $year build failed; no complete release was produced." }
    $framework = if ($year -eq '2024') { 'net48' } elseif ($year -eq '2027') { 'net10.0-windows' } else { 'net8.0-windows' }
    $binaries = Join-Path $root "Archai.Revit/bin/Release/$year/$framework"
    $staging = Join-Path $release "staging/$year"
    $library = Join-Path $staging 'Archai.AirImporter'
    New-Item -ItemType Directory -Force -Path $library | Out-Null
    # Explicit allowlist: never redistribute Autodesk API assemblies or runtime dependencies.
    foreach ($name in @('Archai.AirImporter.dll','Archai.Air.dll','Archai.Plugins.Core.dll','Newtonsoft.Json.dll')) {
        Copy-Item -LiteralPath (Join-Path $binaries $name) -Destination (Join-Path $library $name)
    }
    Copy-Item -LiteralPath (Join-Path $root 'install-local.ps1') -Destination $staging
    Copy-Item -LiteralPath (Join-Path $root 'README.md') -Destination $staging
    Copy-Item -LiteralPath (Join-Path $root 'THIRD-PARTY-NOTICES.txt') -Destination $staging
    Copy-Item -LiteralPath (Join-Path $root 'samples/native-smoke.AIR') -Destination $staging
    $metadata = [ordered]@{ name='ArchAI AIR Importer'; version=$Version; revitVersion=$year; framework=$framework; channel='beta'; validation='API compilation for 2024-2027; Send to ArchAI run on a real Revit 2025 model; Import .AIR and Open in VR runtime validation pending' }
    $metadata | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $staging 'package.json') -Encoding UTF8
    $addin = @'
<?xml version="1.0" encoding="utf-8"?>
<RevitAddIns>
  <AddIn Type="Application">
    <Name>ArchAI AIR Importer</Name>
    <Assembly>Archai.AirImporter\Archai.AirImporter.dll</Assembly>
    <AddInId>8D622CB4-3412-42FA-B14B-86ED12BCDC27</AddInId>
    <FullClassName>Archai.Revit.App</FullClassName>
    <VendorId>ARAI</VendorId>
    <VendorDescription>ArchAI native AIR importer</VendorDescription>
  </AddIn>
</RevitAddIns>
'@
    Set-Content -LiteralPath (Join-Path $staging 'Archai.AirImporter.addin') -Value $addin -Encoding UTF8
    $file = "ArchAI-AIR-Importer-$Version-Revit-$year.zip"
    $zip = Join-Path $upload $file
    Compress-Archive -Path (Join-Path $staging '*') -DestinationPath $zip
    $packages += [ordered]@{ revitVersion=$year; framework=$framework; file=$file; url=$null; sha256=(Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant(); sizeBytes=(Get-Item -LiteralPath $zip).Length }
}
$manifest = [ordered]@{ schemaVersion=1; product='ArchAI AIR Importer'; version=$Version; channel='beta'; packages=$packages }
$manifest | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $upload 'release-manifest.json') -Encoding UTF8
@($packages | ForEach-Object { "$($_.sha256)  $($_.file)" }) | Set-Content -LiteralPath (Join-Path $upload 'SHA256SUMS.txt') -Encoding ASCII
@'
Upload the four version-specific ZIP files to Cloudflare unchanged.
Send their public HTTPS URLs back so the setup wizard can use them.
release-manifest.json contains size and SHA-256 values; URL fields are intentionally null until hosting is configured.
The future setup must verify SHA-256 before extracting and install only the matching Revit version.
These are beta builds. Compilation is verified; in-Revit import/family/stair validation is still required.
Do not upload the tools folder, SDK, source workspace, or Autodesk reference DLLs.
'@ | Set-Content -LiteralPath (Join-Path $upload 'UPLOAD-INSTRUCTIONS.txt') -Encoding UTF8
Compress-Archive -Path (Join-Path $upload '*') -DestinationPath (Join-Path $release "ArchAI-Cloudflare-Upload-$Version.zip")
Write-Host "Release ready: $release"
