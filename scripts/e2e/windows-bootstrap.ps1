param(
  [string]$NodeVersion = "22.19.0",
  [string]$DotnetVersion = "8.0.423"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Root = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$Tools = Join-Path $Root ".tools"
$Downloads = Join-Path $Tools "downloads"
New-Item -ItemType Directory -Force -Path $Downloads | Out-Null

function Download-File {
  param(
    [Parameter(Mandatory = $true)][string]$Uri,
    [Parameter(Mandatory = $true)][string]$Destination
  )

  Write-Host "Downloading $Uri"
  Invoke-WebRequest -UseBasicParsing -Uri $Uri -OutFile $Destination
}

$NodeDir = Join-Path $Tools "node"
$NodeExe = Join-Path $NodeDir "node.exe"
if (-not (Test-Path -LiteralPath $NodeExe)) {
  $NodeArchive = Join-Path $Downloads "node-v$NodeVersion-win-x64.zip"
  $NodeExtract = Join-Path $Tools ".node-extract"
  Remove-Item -LiteralPath $NodeArchive -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $NodeExtract -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $NodeDir -Recurse -Force -ErrorAction SilentlyContinue

  Download-File `
    -Uri "https://nodejs.org/dist/v$NodeVersion/node-v$NodeVersion-win-x64.zip" `
    -Destination $NodeArchive
  Expand-Archive -LiteralPath $NodeArchive -DestinationPath $NodeExtract -Force
  $ExpandedNodeDir = Join-Path $NodeExtract "node-v$NodeVersion-win-x64"
  if (-not (Test-Path -LiteralPath (Join-Path $ExpandedNodeDir "node.exe"))) {
    throw "The Node.js archive did not contain the expected executable"
  }
  Move-Item -LiteralPath $ExpandedNodeDir -Destination $NodeDir
  Remove-Item -LiteralPath $NodeExtract -Recurse -Force
  Remove-Item -LiteralPath $NodeArchive -Force
}

$GoMod = Get-Content -LiteralPath (Join-Path $Root "host\go.mod") -Raw
if ($GoMod -notmatch "(?m)^go\s+([0-9]+\.[0-9]+(?:\.[0-9]+)?)\s*$") {
  throw "Could not read the required Go version from host/go.mod"
}
$GoVersion = $Matches[1]
$GoDir = Join-Path $Tools "go"
$GoExe = Join-Path $GoDir "bin\go.exe"
if (-not (Test-Path -LiteralPath $GoExe)) {
  $GoArchive = Join-Path $Downloads "go$GoVersion.windows-amd64.zip"
  Remove-Item -LiteralPath $GoArchive -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $GoDir -Recurse -Force -ErrorAction SilentlyContinue

  Download-File `
    -Uri "https://go.dev/dl/go$GoVersion.windows-amd64.zip" `
    -Destination $GoArchive
  Expand-Archive -LiteralPath $GoArchive -DestinationPath $Tools -Force
  Remove-Item -LiteralPath $GoArchive -Force
  if (-not (Test-Path -LiteralPath $GoExe)) {
    throw "The Go archive did not contain the expected executable"
  }
}

$DotnetDir = Join-Path $Tools "dotnet"
$DotnetExe = Join-Path $DotnetDir "dotnet.exe"
if (-not (Test-Path -LiteralPath $DotnetExe)) {
  $DotnetInstall = Join-Path $Downloads "dotnet-install.ps1"
  Remove-Item -LiteralPath $DotnetDir -Recurse -Force -ErrorAction SilentlyContinue
  Download-File -Uri "https://dot.net/v1/dotnet-install.ps1" -Destination $DotnetInstall
  Unblock-File -LiteralPath $DotnetInstall -ErrorAction SilentlyContinue
  & $DotnetInstall `
    -Version $DotnetVersion `
    -Architecture "x64" `
    -InstallDir $DotnetDir `
    -NoPath
  if (-not (Test-Path -LiteralPath $DotnetExe)) {
    throw "The .NET SDK installation failed"
  }
}

Write-Host "Pinned toolchain ready:"
& $NodeExe --version
if ($LASTEXITCODE -ne 0) { throw "The Node.js executable failed" }
& $GoExe version
if ($LASTEXITCODE -ne 0) { throw "The Go executable failed" }
& $DotnetExe --version
if ($LASTEXITCODE -ne 0) { throw "The .NET SDK executable failed" }
