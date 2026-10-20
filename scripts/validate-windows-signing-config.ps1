[CmdletBinding()]
param(
  [string]$AllowUnsigned = $env:WINDOWS_ALLOW_UNSIGNED_RELEASE,
  [string]$ExpectedSignerSubject = $env:WINDOWS_EXPECTED_SIGNER_SUBJECT,
  [string]$OrganizationId = $env:SIGNPATH_ORGANIZATION_ID,
  [string]$ApiToken = $env:SIGNPATH_API_TOKEN,
  [string]$SignToolPath = $env:WINDOWS_SIGNTOOL_PATH,
  [string]$Repository = $env:GITHUB_REPOSITORY,
  [string]$ReleaseRef = $env:GITHUB_REF
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if ($AllowUnsigned -cnotin @("", "false", "true")) {
  throw "WINDOWS_ALLOW_UNSIGNED_RELEASE must be unset, false, or true."
}
if ($AllowUnsigned -ceq "true") {
  if (-not [string]::IsNullOrWhiteSpace($ExpectedSignerSubject)) {
    throw "Unsigned mode cannot be combined with WINDOWS_EXPECTED_SIGNER_SUBJECT."
  }
  Write-Warning "This candidate ships UNSIGNED Windows binaries."
  return
}

if ($Repository -cne "dantraynor/tailchrome") {
  throw "Production signing is restricted to dantraynor/tailchrome."
}
if ($ReleaseRef -cnotmatch '^refs/tags/v[0-9]+\.[0-9]+\.[0-9]+$') {
  throw "Production signing requires a version tag; branch and pull-request builds are not eligible."
}
if ([string]::IsNullOrWhiteSpace($ExpectedSignerSubject)) {
  throw "WINDOWS_EXPECTED_SIGNER_SUBJECT must contain the exact production publisher subject."
}
$organization = [Guid]::Empty
if (-not [Guid]::TryParseExact($OrganizationId, "D", [ref]$organization) -or
    $organization -eq [Guid]::Empty) {
  throw "SIGNPATH_ORGANIZATION_ID must identify the approved SignPath organization."
}
if ([string]::IsNullOrWhiteSpace($ApiToken)) {
  throw "SIGNPATH_API_TOKEN must authorize tailchrome/release-signing."
}
if ([string]::IsNullOrWhiteSpace($SignToolPath) -or
    -not (Test-Path -LiteralPath $SignToolPath -PathType Leaf)) {
  throw "The pinned Windows SDK SignTool is required for production signing."
}

Write-Host "Production signing configuration is present for tailchrome/release-signing."
