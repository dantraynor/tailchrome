# Diagnostic scan for a published or candidate binary. This report does not
# replace the controlled release workflow or installation/lifecycle tests.
param(
  [string]$ArtifactPath,
  [string]$ExpectedSha256,
  [string]$ReleaseTag,
  [string]$EvidencePath
)

function Assert-DefenderWindowsSession {
  if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
    throw 'Run this collector on Windows with Microsoft Defender Antivirus.'
  }
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = [Security.Principal.WindowsPrincipal]::new($identity)
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Run this collector from an elevated PowerShell session.'
  }
}

function Invoke-DefenderDiagnosticCommand([string[]]$Arguments) {
  $platformRoot = Join-Path $env:ProgramData 'Microsoft\Windows Defender\Platform'
  $candidates = @(
    Get-ChildItem -LiteralPath $platformRoot -Directory -ErrorAction SilentlyContinue |
      Sort-Object Name -Descending |
      ForEach-Object { Join-Path $_.FullName 'MpCmdRun.exe' } |
      Where-Object { Test-Path -LiteralPath $_ -PathType Leaf }
  )
  $command = Join-Path $env:ProgramFiles 'Windows Defender\MpCmdRun.exe'
  if ($candidates.Count -gt 0) { $command = $candidates[0] }
  if (-not (Test-Path -LiteralPath $command -PathType Leaf)) {
    throw 'MpCmdRun.exe is unavailable.'
  }
  $PSNativeCommandUseErrorActionPreference = $false
  $output = @(& $command @Arguments 2>&1)
  return [pscustomobject]@{ exitCode = $LASTEXITCODE; output = @($output | ForEach-Object { [string]$_ }) }
}

function Invoke-TailchromeDefenderDiagnostic {
  param(
    [Parameter(Mandatory = $true)][string]$ArtifactPath,
    [Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-fA-F]{64}$')][string]$ExpectedSha256,
    [Parameter(Mandatory = $true)][ValidatePattern('^v\d+\.\d+\.\d+$')][string]$ReleaseTag,
    [Parameter(Mandatory = $true)][string]$EvidencePath
  )
  Set-StrictMode -Version Latest
  $ErrorActionPreference = 'Stop'
  # GetFullPath also works when real-time protection already quarantined a file.
  $target = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($ArtifactPath)
  $destination = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($EvidencePath)
  if (Test-Path -LiteralPath $destination) { throw 'Use a new evidence path for every scan; existing evidence is never overwritten.' }
  $parent = Split-Path -Parent $destination
  New-Item -ItemType Directory -Path $parent -Force | Out-Null
  $record = [ordered]@{
    schemaVersion = 1
    purpose = 'diagnostic-only'
    releaseClearance = $false
    releaseTag = $ReleaseTag
    artifactPath = $target
    expectedSha256 = $ExpectedSha256.ToLowerInvariant()
    observedSha256 = $null
    postScanSha256 = $null
    startedAt = [DateTime]::UtcNow.ToString('o')
    completedAt = $null
    operatingSystem = [Environment]::OSVersion.VersionString
    result = 'incomplete'
    defender = $null
    preferences = $null
    commands = @()
    detections = @()
    detectionQueryError = $null
    error = $null
  }
  $windowsReady = $false
  try {
    Assert-DefenderWindowsSession
    $windowsReady = $true
    Update-MpSignature -ErrorAction Stop | Out-Null
    $status = Get-MpComputerStatus -ErrorAction Stop
    $record.defender = $status | Select-Object AMRunningMode, AMEngineVersion, AMProductVersion,
      AntivirusSignatureVersion, AntivirusSignatureLastUpdated, AntivirusEnabled,
      AMServiceEnabled, RealTimeProtectionEnabled, BehaviorMonitorEnabled, IoavProtectionEnabled
    $preferences = Get-MpPreference -ErrorAction Stop
    $record.preferences = $preferences | Select-Object MAPSReporting, PUAProtection,
      DisableBlockAtFirstSeen, ExclusionPath, ExclusionExtension, ExclusionProcess
    if ($status.AMRunningMode -ne 'Normal' -or -not $status.AntivirusEnabled -or
        -not $status.AMServiceEnabled -or -not $status.RealTimeProtectionEnabled -or
        -not $status.BehaviorMonitorEnabled -or -not $status.IoavProtectionEnabled) {
      throw 'Active Defender protection is required.'
    }
    if ($null -eq $status.AntivirusSignatureLastUpdated -or
        $status.AntivirusSignatureLastUpdated.ToUniversalTime() -lt [DateTime]::UtcNow.AddDays(-1) -or
        $status.AntivirusSignatureLastUpdated.ToUniversalTime() -gt [DateTime]::UtcNow.AddMinutes(5)) {
      throw 'Current Defender security intelligence could not be established.'
    }
    if ([int]$preferences.PUAProtection -ne 1 -or [int]$preferences.MAPSReporting -eq 0 -or
        [bool]$preferences.DisableBlockAtFirstSeen) {
      throw 'Enable PUA and cloud protection on the disposable validation VM before scanning.'
    }
    $record.observedSha256 = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($record.observedSha256 -ne $record.expectedSha256) { throw 'Artifact checksum mismatch; refusing to scan different bytes.' }
    $cloud = Invoke-DefenderDiagnosticCommand @('-ValidateMapsConnection')
    $record.commands += [ordered]@{ operation = 'cloud-connectivity'; result = $cloud }
    if ($cloud.exitCode -ne 0) { throw 'Defender cloud connectivity validation failed.' }
    $exclusion = Invoke-DefenderDiagnosticCommand @('-CheckExclusion', '-Path', $target)
    $record.commands += [ordered]@{ operation = 'exclusion-check'; result = $exclusion }
    if ($exclusion.exitCode -ne 1) { throw 'The artifact is excluded, or exclusion status could not be established.' }
    $scan = Invoke-DefenderDiagnosticCommand @('-Scan', '-ScanType', '3', '-File', $target)
    $record.commands += [ordered]@{ operation = 'file-scan'; result = $scan }
    if ($scan.exitCode -ne 0) { throw "Defender scan returned exit code $($scan.exitCode); inspect the report." }
    # Allow delayed cloud verdicts to reach the file and local detection history,
    # matching the release workflow before checking for a clean result.
    Start-Sleep -Seconds 10
    $record.postScanSha256 = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($record.postScanSha256 -ne $record.expectedSha256) { throw 'Artifact changed during scanning.' }
    $record.result = 'no-detection-observed'
  } catch {
    $record.error = $_.Exception.Message
  } finally {
    if ($windowsReady) {
      try {
        $threats = @(Get-MpThreat -ErrorAction Stop)
        $history = @(Get-MpThreatDetection -ErrorAction Stop)
        $leaf = Split-Path -Leaf $target
        $record.detections = @(
          foreach ($detection in $history) {
            $resources = @($detection.Resources | ForEach-Object { [string]$_ })
            $resourceText = $resources -join "`n"
            if ($resourceText.IndexOf($target, [StringComparison]::OrdinalIgnoreCase) -lt 0 -and
                $resourceText.IndexOf($leaf, [StringComparison]::OrdinalIgnoreCase) -lt 0) { continue }
            $names = @($threats | Where-Object { $_.ThreatID -eq $detection.ThreatID } | ForEach-Object { $_.ThreatName })
            [ordered]@{
              threatId = [string]$detection.ThreatID
              threatNames = $names
              detectionId = [string]$detection.DetectionID
              initialDetectionTime = $detection.InitialDetectionTime
              lastThreatStatusChangeTime = $detection.LastThreatStatusChangeTime
              actionSuccess = $detection.ActionSuccess
              resources = $resources
            }
          }
        )
        if ($record.detections.Count -gt 0) {
          # Includes historical detections; a fresh VM is required for a clean
          # retest. A remediated detection may accompany scan exit code zero.
          $record.result = 'detection-recorded'
        }
      } catch {
        $record.detectionQueryError = $_.Exception.Message
        $record.result = 'incomplete'
      }
    }
    $record.completedAt = [DateTime]::UtcNow.ToString('o')
    $record | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $destination -Encoding UTF8
    Write-Host "Defender diagnostic evidence: $destination ($($record.result))"
  }
  if ($record.result -ne 'no-detection-observed') {
    throw "Defender diagnostic did not pass. Review $destination"
  }
}

# Dot-sourcing exposes the collector for fixture tests without scanning.
if ($MyInvocation.InvocationName -ne '.') {
  Invoke-TailchromeDefenderDiagnostic @PSBoundParameters
}
