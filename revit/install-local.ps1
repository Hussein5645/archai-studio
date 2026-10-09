param(
    [Parameter(Mandatory=$true)][ValidateSet('2024','2025','2026','2027')][string]$RevitVersion,
    [string]$PackageDirectory = $PSScriptRoot
)
$ErrorActionPreference = 'Stop'
if (Get-Process Revit -ErrorAction SilentlyContinue) { throw 'Close Revit before installing the plugin.' }
$metadataPath = Join-Path $PackageDirectory 'package.json'
if (!(Test-Path -LiteralPath $metadataPath)) { throw 'Run this script from an extracted version-specific ArchAI plugin ZIP.' }
$metadata = Get-Content -LiteralPath $metadataPath -Raw | ConvertFrom-Json
if ([string]$metadata.revitVersion -ne $RevitVersion) { throw 'Package version does not match the selected Revit version.' }
$destination = Join-Path $env:APPDATA "Autodesk/Revit/Addins/$RevitVersion/Archai.AirImporter"
New-Item -ItemType Directory -Force -Path $destination | Out-Null
foreach ($filename in @('Archai.AirImporter.dll','Archai.Air.dll','Archai.Plugins.Core.dll','Newtonsoft.Json.dll')) {
    $inputFile = Join-Path $PackageDirectory "Archai.AirImporter/$filename"
    if (!(Test-Path -LiteralPath $inputFile)) { throw "Missing plugin file: $filename" }
    Copy-Item -LiteralPath $inputFile -Destination (Join-Path $destination $filename) -Force
}
$assembly = [System.Security.SecurityElement]::Escape((Join-Path $destination 'Archai.AirImporter.dll'))
$manifest = @"
<?xml version="1.0" encoding="utf-8"?>
<RevitAddIns>
  <AddIn Type="Application">
    <Name>ArchAI AIR Importer</Name>
    <Assembly>$assembly</Assembly>
    <AddInId>8D622CB4-3412-42FA-B14B-86ED12BCDC27</AddInId>
    <FullClassName>Archai.Revit.App</FullClassName>
    <VendorId>ARAI</VendorId>
    <VendorDescription>ArchAI native AIR importer</VendorDescription>
  </AddIn>
</RevitAddIns>
"@
$manifestPath = Join-Path (Split-Path $destination -Parent) 'Archai.AirImporter.addin'
Set-Content -LiteralPath $manifestPath -Value $manifest -Encoding UTF8
Write-Host "Installed for Revit $RevitVersion. Open a project and use the ArchAI tab (Export to ArchAI / Import .AIR)."
Write-Host "To uninstall, close Revit and remove $manifestPath and $destination."
