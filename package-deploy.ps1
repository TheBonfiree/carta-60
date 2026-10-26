# ---------------------------------------------------------------------------
# package-deploy.ps1 — build carta-60-deploy.zip for Netlify Drop
#
#   powershell -ExecutionPolicy Bypass -File package-deploy.ps1
#
# Excludes assets/reference/ (34 MB of full-resolution masters). Those are
# never requested by the page, so shipping them would only slow the upload;
# they stay in the git repo. Pass -IncludeMasters to bundle them anyway.
#
# NOTE: this deliberately does NOT use Compress-Archive. In Windows PowerShell
# 5.1 it writes entry names with BACKSLASH separators, which the ZIP spec
# forbids (4.4.17.1: paths must use forward slashes). Unpackers that follow the
# spec then produce flat files literally named "assets\hero\hero.webp" and the
# deployed site 404s on everything. Entries are written by hand below so the
# separators are correct.
# ---------------------------------------------------------------------------
param([switch]$IncludeMasters)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$root = $PSScriptRoot
$zip  = Join-Path $root 'carta-60-deploy.zip'

# Everything the live site needs. assets/reference is absent by design.
$dirs = @('css', 'js', 'vendor', 'netlify/functions',
          'assets/assembly', 'assets/assembly-mobile',
          'assets/hero', 'assets/detail', 'assets/model')
if ($IncludeMasters) { $dirs += 'assets/reference' }
$files = @('index.html', 'netlify.toml')

if (Test-Path $zip) { Remove-Item $zip -Force }
$archive = [System.IO.Compression.ZipFile]::Open($zip, 'Create')

$script:count = 0

function Add-Entry($fullPath, $entryName) {
    # $entryName must already use forward slashes.
    $script:count++
    $entry  = $archive.CreateEntry($entryName, 'Optimal')
    $out    = $entry.Open()
    $bytes  = [System.IO.File]::ReadAllBytes($fullPath)
    $out.Write($bytes, 0, $bytes.Length)
    $out.Dispose()
}

foreach ($f in $files) {
    Add-Entry (Join-Path $root $f) $f
}

foreach ($d in $dirs) {
    $src = Join-Path $root ($d -replace '/', '\')
    Get-ChildItem $src -File -Recurse | ForEach-Object {
        $rel = $_.FullName.Substring($root.Length + 1) -replace '\\', '/'
        Add-Entry $_.FullName $rel
    }
}

# Counted while writing, not read back from $archive.Entries — that collection
# is empty for an archive opened in Create mode, so it always reported 0 files.
$count = $script:count
$archive.Dispose()

$mb = [math]::Round((Get-Item $zip).Length / 1MB, 1)
Write-Host "carta-60-deploy.zip  ($count files, $mb MB)"
Write-Host "-> drag onto https://app.netlify.com/drop"
