Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$validator = Join-Path $PSScriptRoot "validate-windows-signing-config.ps1"
$fixture = [System.IO.Path]::GetTempFileName()
$passed = 0

# This file is only a configuration-validation fixture. It is never executed
# and cannot stand in for the signature verifier's real Windows SDK tool.
$valid = @{
  AllowUnsigned = "false"
  ExpectedSignerSubject = "CN=Configuration test fixture"
  OrganizationId = "00000000-0000-0000-0000-000000000001"
  ApiToken = "configuration-test-fixture"
  SignToolPath = $fixture
  Repository = "dantraynor/tailchrome"
  ReleaseRef = "refs/tags/v0.1.16"
}

function Test-Configuration {
  param([string]$Name, [hashtable]$Overrides, [string]$ExpectedError = "")
  $arguments = $valid.Clone()
  foreach ($key in $Overrides.Keys) { $arguments[$key] = $Overrides[$key] }
  $failure = $null
  try { & $validator @arguments -WarningAction SilentlyContinue }
  catch { $failure = $_.Exception.Message }
  if ($ExpectedError) {
    if ($null -eq $failure -or -not $failure.Contains($ExpectedError)) {
      throw "$Name did not reject the configuration as expected: $failure"
    }
    if ($failure.Contains($valid.ApiToken)) {
      throw "$Name leaked the signing token in its error."
    }
  } elseif ($null -ne $failure) {
    throw "$Name rejected a valid configuration: $failure"
  }
  $script:passed++
  Write-Host "PASS: $Name"
}

try {
  Test-Configuration "configured production release" @{}
  Test-Configuration "signed mode is the default" @{ AllowUnsigned = "" }
  Test-Configuration "explicit unsigned release needs no signing credentials" @{
    AllowUnsigned = "true"; ExpectedSignerSubject = ""; OrganizationId = ""
    ApiToken = ""; SignToolPath = ""; Repository = ""; ReleaseRef = ""
  }
  Test-Configuration "unsigned and signed settings conflict" @{
    AllowUnsigned = "true"
  } "Unsigned mode cannot be combined"
  Test-Configuration "invalid unsigned opt-in is rejected" @{
    AllowUnsigned = "yes"
  } "must be unset, false, or true"
  Test-Configuration "another repository cannot request production signing" @{
    Repository = "someone/tailchrome"
  } "restricted to dantraynor/tailchrome"
  Test-Configuration "branch builds cannot request production signing" @{
    ReleaseRef = "refs/heads/main"
  } "requires a version tag"
  Test-Configuration "pull requests cannot request production signing" @{
    ReleaseRef = "refs/pull/133/merge"
  } "requires a version tag"
  Test-Configuration "missing publisher is rejected" @{
    ExpectedSignerSubject = " "
  } "exact production publisher"
  Test-Configuration "invalid organization is rejected" @{
    OrganizationId = "not-an-organization"
  } "approved SignPath organization"
  Test-Configuration "empty organization is rejected" @{
    OrganizationId = [Guid]::Empty.ToString()
  } "approved SignPath organization"
  Test-Configuration "missing signing token is rejected" @{
    ApiToken = " "
  } "must authorize tailchrome/release-signing"
  Test-Configuration "missing verification tool is rejected" @{
    SignToolPath = "$fixture.absent"
  } "pinned Windows SDK SignTool"
  Write-Host "$passed signing-configuration checks passed."
} finally {
  Remove-Item -LiteralPath $fixture -Force
}
