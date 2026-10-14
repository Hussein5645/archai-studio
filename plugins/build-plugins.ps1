# Builds and packages the ArchAI plugins into plugins/dist (see docs/plugins.md):
#   powershell -ExecutionPolicy Bypass -File plugins/build-plugins.ps1 [-Version 0.3.0] [-Skip AutoCAD,Rhino]
# Open in VR publishes with the ArchAI account signed in in the desktop app (asked over the live
# link), so nothing secret is built in. The Revit plugin has its own packaging
# (revit/build-packages.ps1, revit/build-setup.ps1).
param(
    [string]$Version = '0.5.5',
    [string[]]$Skip = @(),
    [string]$Dotnet = 'dotnet'
)
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$dist = Join-Path $root 'dist'
$stage = Join-Path $dist 'stage'
if (Test-Path $stage) { Remove-Item -Recurse -Force -Confirm:$false $stage }
New-Item -ItemType Directory -Force -Path $stage | Out-Null

$icons = Join-Path $root 'icons\png'

function Copy-Icons([string]$to, [string[]]$names, [int[]]$sizes, [switch]$Plain) {
    New-Item -ItemType Directory -Force -Path $to | Out-Null
    foreach ($n in $names) {
        foreach ($s in $sizes) {
            $target = if ($Plain) { "$n.png" } else { "$n-$s.png" }
            Copy-Item (Join-Path $icons "$n-$s.png") (Join-Path $to $target)
        }
    }
}
function Write-Text([string]$path, [string]$text) { [IO.File]::WriteAllText($path, $text, (New-Object Text.UTF8Encoding($false))) }
Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
# Zip entries with forward slashes (Compress-Archive in Windows PowerShell writes backslashes,
# which macOS installers of Blender and SketchUp read as file names).
function Zip([string]$from, [string]$file) {
    $target = Join-Path $dist $file
    if (Test-Path $target) { Remove-Item -Force -Confirm:$false $target }
    $base = (Resolve-Path $from).Path.TrimEnd('\') + '\'
    $archive = [IO.Compression.ZipFile]::Open($target, 'Create')
    try {
        foreach ($item in Get-ChildItem -Recurse -File $from) {
            $name = $item.FullName.Substring($base.Length).Replace('\', '/')
            [void][IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, $item.FullName, $name, 'Optimal')
        }
    } finally { $archive.Dispose() }
    Write-Host "  $file"
}
$all = @('logo', 'export', 'import', 'sync', 'vr', 'web')

Write-Host 'Building...'
if ($Skip -notcontains 'AutoCAD') {
    & $Dotnet build (Join-Path $root 'autocad\Archai.AutoCAD\Archai.AutoCAD.csproj') -c Release --nologo -v:q
    if ($LASTEXITCODE -ne 0) { throw 'AutoCAD build failed' }
    $bundle = Join-Path $stage 'autocad\ArchAI.bundle'
    $contents = Join-Path $bundle 'Contents'
    New-Item -ItemType Directory -Force -Path $contents | Out-Null
    Copy-Item (Join-Path $root 'autocad\PackageContents.xml') $bundle
    $bin = Join-Path $root 'autocad\Archai.AutoCAD\bin\Release\net8.0-windows'
    foreach ($f in 'Archai.AutoCAD.dll', 'Archai.Plugins.Core.dll', 'Newtonsoft.Json.dll') { Copy-Item (Join-Path $bin $f) $contents }
    Copy-Item (Join-Path $icons 'logo.ico') $contents
    Zip (Join-Path $stage 'autocad') "ArchAI-AutoCAD-$Version.zip"
}
if ($Skip -notcontains 'Rhino') {
    & $Dotnet build (Join-Path $root 'rhino\Archai.Rhino\Archai.Rhino.csproj') -c Release --nologo -v:q
    if ($LASTEXITCODE -ne 0) { throw 'Rhino build failed' }
    $to = Join-Path $stage 'rhino\ArchAI'
    New-Item -ItemType Directory -Force -Path $to | Out-Null
    $bin = Join-Path $root 'rhino\Archai.Rhino\bin\Release\net48'
    foreach ($f in 'ArchAI.rhp', 'Archai.Plugins.Core.dll', 'Newtonsoft.Json.dll') { Copy-Item (Join-Path $bin $f) $to }
    Zip (Join-Path $stage 'rhino') "ArchAI-Rhino-$Version.zip"
}
if ($Skip -notcontains 'Blender') {
    $to = Join-Path $stage 'blender\archai'
    New-Item -ItemType Directory -Force -Path $to | Out-Null
    Copy-Item (Join-Path $root 'blender\archai\__init__.py'), (Join-Path $root 'blender\archai\blender_manifest.toml'), (Join-Path $root 'python\archai_core.py') $to
    Copy-Icons (Join-Path $to 'icons') $all @(64) -Plain
    Zip (Join-Path $stage 'blender') "ArchAI-Blender-$Version.zip"
}
if ($Skip -notcontains '3dsMax') {
    $bundle = Join-Path $stage '3dsmax\ArchAI.bundle'
    $contents = Join-Path $bundle 'Contents'
    $package = Join-Path $contents 'archai_max'
    New-Item -ItemType Directory -Force -Path $package | Out-Null
    Copy-Item (Join-Path $root '3dsmax\PackageContents.xml') $bundle
    Copy-Item (Join-Path $root '3dsmax\archai_startup.ms') $contents
    Copy-Item (Join-Path $root '3dsmax\archai_max\*.py'), (Join-Path $root 'python\archai_core.py') $package
    Copy-Icons (Join-Path $package 'icons') $all @(32, 48)
    Zip (Join-Path $stage '3dsmax') "ArchAI-3dsMax-$Version.zip"
}
if ($Skip -notcontains 'SketchUp') {
    $to = Join-Path $stage 'sketchup'
    New-Item -ItemType Directory -Force -Path (Join-Path $to 'archai') | Out-Null
    Copy-Item (Join-Path $root 'sketchup\archai.rb') $to
    Copy-Item (Join-Path $root 'sketchup\archai\*.rb') (Join-Path $to 'archai')
    Copy-Icons (Join-Path $to 'archai\icons') @('export', 'import', 'sync', 'vr', 'web') @(16, 24)
    Copy-Icons (Join-Path $to 'archai\icons') @('logo') @(64)
    Zip $to "ArchAI-SketchUp-$Version.rbz"
}
if ($Skip -notcontains 'Unreal') {
    $to = Join-Path $stage 'unreal\ArchAI'
    New-Item -ItemType Directory -Force -Path (Join-Path $stage 'unreal') | Out-Null
    Copy-Item -Recurse (Join-Path $root 'unreal\ArchAI') (Join-Path $stage 'unreal')
    $package = Join-Path $to 'Content\Python\archai_unreal'
    Copy-Item (Join-Path $root 'python\archai_core.py') $package
    New-Item -ItemType Directory -Force -Path (Join-Path $to 'Resources') | Out-Null
    Copy-Item (Join-Path $icons 'logo-128.png') (Join-Path $to 'Resources\Icon128.png')
    Get-ChildItem -Recurse -Directory -Filter __pycache__ $to | Remove-Item -Recurse -Force -Confirm:$false
    Zip (Join-Path $stage 'unreal') "ArchAI-Unreal-$Version.zip"
}
Remove-Item -Recurse -Force -Confirm:$false $stage
Write-Host "Done: $dist"
