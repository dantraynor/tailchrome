param(
  [string]$Version = "",
  [string]$HelperExe = "",
  [string]$OutPath = "",
  [string]$ExpectedSignerSubject = "",
  [string]$SignToolPath = $env:WINDOWS_SIGNTOOL_PATH,
  [switch]$AllowUnsignedDevelopmentBuild
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$Root = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
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
$HelperExe = (Resolve-Path -LiteralPath $HelperExe).Path

if ($AllowUnsignedDevelopmentBuild) {
  if (-not [string]::IsNullOrWhiteSpace($ExpectedSignerSubject)) {
    throw "-AllowUnsignedDevelopmentBuild cannot be combined with -ExpectedSignerSubject."
  }
  Write-Warning "Building a development MSI without validating the helper signature. This output is not eligible for release."
} else {
  if ([string]::IsNullOrWhiteSpace($ExpectedSignerSubject)) {
    throw "Release-quality MSI builds require -ExpectedSignerSubject. Use -AllowUnsignedDevelopmentBuild only for local testing."
  }

  $Signatures = @(Get-AuthenticodeSignature -LiteralPath $HelperExe)
  if ($Signatures.Count -ne 1) {
    throw "Expected exactly one Authenticode result for '$HelperExe'; found $($Signatures.Count)."
  }

  $Signature = $Signatures[0]
  if ($Signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid) {
    throw "The helper Authenticode signature is not valid: $($Signature.Status)."
  }
  if ($null -eq $Signature.SignerCertificate) {
    throw "The helper Authenticode signature does not contain a signer certificate."
  }
  if (-not [string]::Equals(
      $Signature.SignerCertificate.Subject,
      $ExpectedSignerSubject,
      [System.StringComparison]::Ordinal
    )) {
    throw "Unexpected helper signer subject. Expected '$ExpectedSignerSubject'; found '$($Signature.SignerCertificate.Subject)'."
  }
  if ($null -eq $Signature.TimeStamperCertificate) {
    throw "The helper Authenticode signature is not timestamped."
  }

  if ([string]::IsNullOrWhiteSpace($SignToolPath)) {
    throw "Release-quality MSI builds require -SignToolPath to the pinned Windows SDK SignTool."
  }
  $ResolvedSignTool = Resolve-Path -LiteralPath $SignToolPath -ErrorAction Stop
  if (@($ResolvedSignTool).Count -ne 1 -or
      -not (Test-Path -LiteralPath $ResolvedSignTool.Path -PathType Leaf)) {
    throw "SignTool must resolve to exactly one file: '$SignToolPath'."
  }

  $SignToolOutput = @(& $ResolvedSignTool.Path verify /pa /all /v $HelperExe 2>&1)
  if ($LASTEXITCODE -ne 0) {
    throw "SignTool rejected the helper before MSI construction: $($SignToolOutput -join [Environment]::NewLine)"
  }
  $SignatureIndexes = @(
    $SignToolOutput | Select-String -Pattern "^\s*Signature Index:\s*\d+\b"
  )
  if ($SignatureIndexes.Count -gt 1) {
    throw "The helper contains multiple Authenticode signatures; the signer result is ambiguous."
  }
  if ($SignatureIndexes.Count -ne 1) {
    throw "SignTool could not prove that the helper has exactly one Authenticode signature."
  }
  $Sha256DigestLines = @(
    $SignToolOutput | Select-String -Pattern "(?i)Hash of file \(sha256\):"
  )
  if ($Sha256DigestLines.Count -ne 1) {
    throw "The helper does not have exactly one SHA-256 Authenticode file digest."
  }
}

if ([string]::IsNullOrWhiteSpace($OutPath)) {
  $OutPath = Join-Path $Root "dist\tailchrome-helper-windows-x64.msi"
}
$OutPath = [System.IO.Path]::GetFullPath($OutPath)
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
