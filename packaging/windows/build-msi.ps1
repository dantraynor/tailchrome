param(
  [string]$Version = "",
  [string]$HelperExe = "",
  [string]$OutPath = ""
)

$ErrorActionPreference = "Stop"

$Root = Resolve-Path (Join-Path $PSScriptRoot "..\..")
if ([string]::IsNullOrWhiteSpace($Version)) {
  $Version = (git -C $Root describe --tags --always 2>$null)
  if ([string]::IsNullOrWhiteSpace($Version)) {
    $Version = "dev"
  }
}

$VersionMsi = $Version.TrimStart("v").Split("-")[0]
if ($VersionMsi -notmatch "^\d+\.\d+\.\d+$") {
  $VersionMsi = "0.0.0"
}

if ([string]::IsNullOrWhiteSpace($HelperExe)) {
  $HelperExe = Join-Path $Root "dist\tailscale-browser-ext-windows-amd64.exe"
}
$HelperExe = Resolve-Path $HelperExe

if ([string]::IsNullOrWhiteSpace($OutPath)) {
  $OutPath = Join-Path $Root "dist\tailchrome-helper-windows-x64.msi"
}
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $OutPath) | Out-Null

if (-not (Get-Command wix -ErrorAction SilentlyContinue)) {
  throw "WiX is required. Install it with: dotnet tool install --global wix --version 6.0.2"
}

$Wxs = Join-Path $PSScriptRoot "Product.wxs"
Write-Host "Building Windows MSI $OutPath (version $VersionMsi)..."
wix build `
  -arch x64 `
  -d "Version=$VersionMsi" `
  -d "HelperExe=$HelperExe" `
  $Wxs `
  -out $OutPath

if ($LASTEXITCODE -ne 0) {
  throw "wix build failed with exit code $LASTEXITCODE"
}

Write-Host "Done: $OutPath"
