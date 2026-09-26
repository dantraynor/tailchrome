# Test the actual Windows registry behavior without initializing or changing
# Defender itself. Run under both Windows PowerShell 5.1 and PowerShell 7.
$ErrorActionPreference = 'Stop'
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
  throw 'These registry regression tests require Windows.'
}
$tokens = $null
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile(
  (Join-Path $PSScriptRoot 'initialize-windows-defender.ps1'), [ref]$tokens, [ref]$parseErrors
)
if ($parseErrors.Count -gt 0) { throw 'Defender initializer has parse errors.' }
$definition = $ast.Find({
  param($node)
  $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
    $node.Name -eq 'Assert-DefenderActiveModePolicy'
}, $true)
if ($null -eq $definition) { throw 'Policy validation function is missing.' }
# Load only the production policy check; never execute initialization in tests.
Invoke-Expression $definition.Extent.Text
$key = 'HKCU:\Software\TailchromeDefenderTest-' + [guid]::NewGuid().ToString('N')
try {
  Assert-DefenderActiveModePolicy -PolicyPath $key
  Write-Output 'PASS: absent registry key'
  New-Item -Path $key | Out-Null
  Assert-DefenderActiveModePolicy -PolicyPath $key
  Write-Output 'PASS: existing key with absent optional value'
  New-ItemProperty -Path $key -Name ForceDefenderPassiveMode -PropertyType DWord -Value 0 | Out-Null
  Assert-DefenderActiveModePolicy -PolicyPath $key
  Write-Output 'PASS: explicit active-mode policy'
  Set-ItemProperty -Path $key -Name ForceDefenderPassiveMode -Value 1
  $rejected = $false
  try { Assert-DefenderActiveModePolicy -PolicyPath $key } catch {
    if ($_.Exception.Message -notlike '*ForceDefenderPassiveMode is enabled*') { throw }
    $rejected = $true
  }
  if (-not $rejected) { throw 'Passive-mode policy was incorrectly accepted.' }
  Write-Output 'PASS: rejects passive-mode policy'
} finally {
  if (Test-Path -LiteralPath $key) { Remove-Item -LiteralPath $key -Recurse -Force }
}

# Defender can omit the legacy intrusion-prevention preference while the
# Network Inspection System is active. Test the actual runtime-state gate.
foreach ($name in @('Get-Readiness', 'Get-ConfiguredValues')) {
  $definition = $ast.Find({
    param($node)
    $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name
  }, $true)
  Invoke-Expression $definition.Extent.Text
}
$script:fixtureNisEnabled = $true
# Load the service-controller enum before mocking Get-Service on PowerShell 5.1.
Microsoft.PowerShell.Management\Get-Service -Name EventLog | Out-Null
function Get-Service { [pscustomobject]@{ Status = [System.ServiceProcess.ServiceControllerStatus]::Running } }
function Get-MpComputerStatus {
  [pscustomobject]@{
    AMRunningMode = 'Normal'; AMServiceEnabled = $true; AntivirusEnabled = $true
    RealTimeProtectionEnabled = $true; BehaviorMonitorEnabled = $true
    IoavProtectionEnabled = $true; OnAccessProtectionEnabled = $true
    NISEnabled = $script:fixtureNisEnabled
    AntivirusSignatureLastUpdated = Get-Date; AntivirusSignatureAge = 0
  }
}
function Get-MpPreference {
  [pscustomobject]@{
    ExclusionPath = @(); ExclusionExtension = @(); ExclusionProcess = @()
    DisableRealtimeMonitoring = $false; DisableBehaviorMonitoring = $false
    DisableIOAVProtection = $false; DisableScriptScanning = $false
    DisableArchiveScanning = $false; DisableBlockAtFirstSeen = $false
    DisableAutoExclusions = $true; MAPSReporting = 2; SubmitSamplesConsent = 1
    PUAProtection = 1; CheckForSignaturesBeforeRunningScan = $true
    SignatureDisableUpdateOnStartupWithoutEngine = $false
  }
}
if (-not (Get-Readiness).Ready) { throw 'Active NIS with the absent legacy preference was rejected.' }
Write-Output 'PASS: active network inspection with absent legacy preference'
$script:fixtureNisEnabled = $false
if ((Get-Readiness).Ready) { throw 'Disabled network inspection was accepted.' }
Write-Output 'PASS: rejects disabled network inspection'

# A nonexistent file makes current MpCmdRun builds return an error instead of
# an exclusion verdict. Exercise the production setup with an inert placeholder;
# stop before it writes the antivirus test signature.
$definition = $ast.Find({
  param($node)
  $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
    $node.Name -eq 'Assert-DetectionSmokeTest'
}, $true)
Invoke-Expression $definition.Extent.Text
function Get-DetectionIds { @() }
$script:checkedSmokePath = $null
function Invoke-MpCmdRun {
  param($FilePath, $Arguments)
  $script:checkedSmokePath = $Arguments[2]
  if (-not (Test-Path -LiteralPath $script:checkedSmokePath -PathType Leaf)) {
    throw 'Exclusion check received a nonexistent file.'
  }
  if ((Get-Content -LiteralPath $script:checkedSmokePath -Raw) -ne 'Defender smoke-test placeholder') {
    throw 'The exclusion check must precede the antivirus test signature.'
  }
  return @{ ExitCode = 0 }
}
$rejected = $false
try { Assert-DetectionSmokeTest -MpCmdRunPath 'fixture-only' } catch {
  if ($_.Exception.Message -ne 'The Defender smoke-test path is excluded from scanning.') { throw }
  $rejected = $true
}
if (-not $rejected) { throw 'Smoke test accepted an excluded path.' }
if (Test-Path -LiteralPath (Split-Path -Parent $script:checkedSmokePath)) {
  throw 'Smoke-test fixture was not cleaned up.'
}
Write-Output 'PASS: exclusion check uses an existing inert file and rejects exclusions'

# A successful update API call can leave stale definitions installed. Exercise
# fallback against the observed signature age, not only cmdlet exceptions.
$definition = $ast.Find({
  param($node)
  $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
    $node.Name -eq 'Update-DefenderSecurityIntelligence'
}, $true)
Invoke-Expression $definition.Extent.Text
function Update-MpSignature {
  param($UpdateSource, $ErrorAction)
  $script:updateCalls.Add($UpdateSource)
  if ($script:updateScenario -eq 'first-throws' -and $UpdateSource -eq 'MicrosoftUpdateServer') {
    throw 'Fixture source failure'
  }
}
function Get-MpComputerStatus {
  $fresh = $script:updateScenario -eq 'first-fresh' -or
    ($script:updateScenario -ne 'both-stale' -and $script:updateCalls[-1] -eq 'MMPC')
  [pscustomobject]@{
    AntivirusSignatureLastUpdated = (Get-Date).AddDays($(if ($fresh) { 0 } else { -100 }))
    AntivirusSignatureAge = $(if ($fresh) { 0 } else { 100 })
  }
}
foreach ($scenario in @('first-fresh', 'first-stale', 'first-throws', 'both-stale')) {
  $script:updateScenario = $scenario
  $script:updateCalls = [System.Collections.Generic.List[string]]::new()
  if ($scenario -eq 'both-stale') {
    $rejected = $false
    try { Update-DefenderSecurityIntelligence | Out-Null } catch {
      if ($_.Exception.Message -notlike 'Defender security intelligence update failed:*') { throw }
      $rejected = $true
    }
    if (-not $rejected -or ($script:updateCalls -join ',') -ne 'MicrosoftUpdateServer,MMPC') {
      throw 'Stale definitions from both sources were not rejected.'
    }
  } else {
    $source = Update-DefenderSecurityIntelligence
    $expected = if ($scenario -eq 'first-fresh') { 'MicrosoftUpdateServer' } else { 'MMPC' }
    $expectedCalls = if ($scenario -eq 'first-fresh') { 'MicrosoftUpdateServer' } else { 'MicrosoftUpdateServer,MMPC' }
    if ($source -ne $expected -or ($script:updateCalls -join ',') -ne $expectedCalls) {
      throw "Incorrect update fallback for $scenario."
    }
  }
  Write-Output "PASS: security intelligence update $scenario"
}
