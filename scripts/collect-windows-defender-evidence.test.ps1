# Cross-platform fixtures; these exercise reporting, not Defender itself.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'collect-windows-defender-evidence.ps1')
$root = Join-Path ([IO.Path]::GetTempPath()) ('tailchrome-defender-tests-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $root | Out-Null
$script:mode = ''
$script:scanCalls = 0
$script:target = ''
$script:cloudVerdictReady = $false
function Assert-DefenderWindowsSession { }
function Update-MpSignature { }
function Start-Sleep([int]$Seconds) {
  if ($Seconds -ne 10 -or $script:scanCalls -ne 1) {
    throw 'Wait ten seconds after scanning for delayed cloud verdicts.'
  }
  $script:cloudVerdictReady = $true
  if ($script:mode -eq 'late-quarantine') { Remove-Item -LiteralPath $script:target }
  if ($script:mode -eq 'late-changed') { Add-Content -LiteralPath $script:target -Value 'changed' }
}
function Get-MpComputerStatus {
  [pscustomobject]@{
    AMRunningMode = $(if ($script:mode -eq 'passive') { 'Passive' } else { 'Normal' })
    AMEngineVersion = 'fixture'; AMProductVersion = 'fixture'
    AntivirusSignatureVersion = '1.2.3.4'
    AntivirusSignatureLastUpdated = $(if ($script:mode -eq 'stale') { (Get-Date).AddDays(-3) } else { Get-Date })
    AntivirusEnabled = $true; AMServiceEnabled = $true; RealTimeProtectionEnabled = $true
    BehaviorMonitorEnabled = $true; IoavProtectionEnabled = $true
  }
}
function Get-MpPreference {
  [pscustomobject]@{
    PUAProtection = 1; MAPSReporting = 2; DisableBlockAtFirstSeen = $false
    ExclusionPath = @(); ExclusionExtension = @(); ExclusionProcess = @()
  }
}
function Invoke-DefenderDiagnosticCommand([string[]]$Arguments) {
  $code = 0
  if ($Arguments[0] -eq '-CheckExclusion') {
    $code = $(if ($script:mode -eq 'excluded') { 0 } else { 1 })
  }
  if ($Arguments[0] -eq '-ValidateMapsConnection' -and $script:mode -eq 'offline') { $code = 2 }
  if ($Arguments[0] -eq '-Scan') {
    $script:scanCalls++
    if ($script:mode -eq 'quarantine') { Remove-Item -LiteralPath $script:target }
    if ($script:mode -eq 'scan-error') { $code = 2 }
    if ($script:mode -eq 'changed') { Add-Content -LiteralPath $script:target -Value 'changed' }
  }
  [pscustomobject]@{ exitCode = $code; output = @('fixture output') }
}
function Get-MpThreat {
  [pscustomobject]@{ ThreatID = 2147735505; ThreatName = 'Test:Fixture/Detection' }
}
function Get-MpThreatDetection {
  if ($script:mode -eq 'query-error') { throw 'history unavailable' }
  $lateDetection = $script:cloudVerdictReady -and $script:mode -in @('late-detected', 'late-quarantine')
  if ($script:mode -in @('detected', 'quarantine', 'missing') -or $lateDetection) {
    [pscustomobject]@{
      ThreatID = 2147735505; DetectionID = 'fixture-detection'
      InitialDetectionTime = Get-Date; LastThreatStatusChangeTime = Get-Date
      ActionSuccess = $true; Resources = @('file:_' + $script:target)
    }
  }
}
$cases = @(
  @{ mode = 'pass'; expected = 'no-detection-observed'; scans = 1 },
  @{ mode = 'late-detected'; expected = 'detection-recorded'; scans = 1 },
  @{ mode = 'late-quarantine'; expected = 'detection-recorded'; scans = 1 },
  @{ mode = 'late-changed'; expected = 'incomplete'; scans = 1 },
  @{ mode = 'detected'; expected = 'detection-recorded'; scans = 1 },
  @{ mode = 'quarantine'; expected = 'detection-recorded'; scans = 1 },
  @{ mode = 'missing'; expected = 'detection-recorded'; scans = 0 },
  @{ mode = 'mismatch'; expected = 'incomplete'; scans = 0 },
  @{ mode = 'passive'; expected = 'incomplete'; scans = 0 },
  @{ mode = 'stale'; expected = 'incomplete'; scans = 0 },
  @{ mode = 'excluded'; expected = 'incomplete'; scans = 0 },
  @{ mode = 'offline'; expected = 'incomplete'; scans = 0 },
  @{ mode = 'scan-error'; expected = 'incomplete'; scans = 1 },
  @{ mode = 'query-error'; expected = 'incomplete'; scans = 1 },
  @{ mode = 'changed'; expected = 'incomplete'; scans = 1 }
)
try {
  foreach ($case in $cases) {
    $script:mode = $case.mode
    $script:scanCalls = 0
    $script:cloudVerdictReady = $false
    $script:target = Join-Path $root 'helper.exe'
    Set-Content -LiteralPath $script:target -Value 'fixture binary'
    $hash = (Get-FileHash -LiteralPath $script:target -Algorithm SHA256).Hash
    if ($case.mode -eq 'mismatch') { $hash = '0' * 64 }
    if ($case.mode -eq 'missing') { Remove-Item -LiteralPath $script:target }
    $evidence = Join-Path $root ($case.mode + '.json')
    $failed = $false
    try {
      Invoke-TailchromeDefenderDiagnostic -ArtifactPath $script:target -ExpectedSha256 $hash `
        -ReleaseTag 'v0.1.14' -EvidencePath $evidence
    } catch { $failed = $true }
    $report = Get-Content -LiteralPath $evidence -Raw | ConvertFrom-Json
    if ($report.result -ne $case.expected -or $script:scanCalls -ne $case.scans -or
        $failed -ne ($case.mode -ne 'pass') -or $report.releaseClearance -ne $false) {
      throw "Wrong outcome for $($case.mode): $($report | ConvertTo-Json -Depth 8)"
    }
    if ($case.expected -eq 'detection-recorded' -and
        ($report.detections[0].threatNames[0] -ne 'Test:Fixture/Detection' -or
         $report.detections[0].threatId -ne '2147735505')) {
      throw 'The diagnostic omitted the threat name or ID.'
    }
    if ($case.mode -eq 'late-quarantine' -and
        ($null -ne $report.postScanSha256 -or [string]::IsNullOrWhiteSpace($report.error))) {
      throw 'The post-scan hash did not observe the delayed quarantine.'
    }
    if ($case.mode -eq 'late-changed' -and $report.error -ne 'Artifact changed during scanning.') {
      throw 'The post-scan hash did not observe the delayed file change.'
    }
    Write-Output "PASS: $($case.mode)"
  }
  $saved = Get-Content -LiteralPath $evidence -Raw
  $failed = $false
  try {
    Invoke-TailchromeDefenderDiagnostic -ArtifactPath $script:target -ExpectedSha256 $hash `
      -ReleaseTag 'v0.1.14' -EvidencePath $evidence
  } catch { $failed = $true }
  if (-not $failed -or (Get-Content -LiteralPath $evidence -Raw) -ne $saved) {
    throw 'Existing evidence was overwritten.'
  }
  Write-Output 'PASS: preserves existing evidence'
} finally {
  Remove-Item -LiteralPath $root -Recurse -Force
}
