param(
    [string]$Dotnet = 'dotnet',
    [string]$ManifestPath = (Join-Path $PSScriptRoot 'artifacts/setup/release-manifest.json')
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Xml.Linq
$release = Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json
if ($release.version -notmatch '^[0-9A-Za-z.-]+$') { throw 'Invalid release version.' }
if (@($release.packages).Count -ne 4) { throw 'Expected four Revit packages.' }
$xml = [System.Xml.Linq.XElement]::new([System.Xml.Linq.XName]::Get('Release'))
$xml.SetAttributeValue('version', [string]$release.version)
$years = @()
foreach ($package in $release.packages) {
    if ($package.revitVersion -notin @('2024','2025','2026','2027') -or $years -contains $package.revitVersion) { throw 'Invalid or duplicate Revit year.' }
    $years += $package.revitVersion
    if (([Uri]$package.url).Scheme -ne 'https' -or $package.sha256 -notmatch '^[a-f0-9]{64}$' -or $package.sizeBytes -le 0) { throw 'Package URL, hash or size is invalid.' }
    $entry = [System.Xml.Linq.XElement]::new([System.Xml.Linq.XName]::Get('Package'))
    foreach ($field in @('revitVersion','url','sha256','sizeBytes')) { $entry.SetAttributeValue($field, [string]$package.$field) }
    $xml.Add($entry)
}
$xml.Save((Join-Path $PSScriptRoot 'Archai.Setup/Packages.xml'))
& $Dotnet build (Join-Path $PSScriptRoot 'Archai.Setup/Archai.Setup.csproj') -c Release --nologo -v:q
if ($LASTEXITCODE -ne 0) { throw 'Setup compilation failed.' }
$output = Join-Path $PSScriptRoot 'artifacts/setup'
New-Item -ItemType Directory -Force -Path $output | Out-Null
$filename = "ArchAI-Revit-Setup-$($release.version).exe"
$destination = Join-Path $output $filename
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'Archai.Setup/bin/Release/net48/ArchAI-Revit-Setup.exe') -Destination $destination -Force
$checksum = (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLowerInvariant()
"$checksum  $filename" | Set-Content -LiteralPath (Join-Path $output 'SETUP-SHA256.txt') -Encoding ASCII
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'SETUP-README.txt') -Destination $output -Force
Write-Output "Setup: $destination"
Write-Output "SHA-256: $checksum"
