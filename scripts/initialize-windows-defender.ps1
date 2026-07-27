param(
  [ValidateRange(10, 300)]
  [int]$ReadinessTimeoutSeconds = 90,

  [switch]$RunDetectionSmokeTest,

  [string]$SummaryPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$PSNativeCommandUseErrorActionPreference = $false

function Assert-ElevatedSession {
  $Identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
  $Principal = [System.Security.Principal.WindowsPrincipal]::new($Identity)
  $AdministratorRole = [System.Security.Principal.WindowsBuiltInRole]::Administrator
  if (-not $Principal.IsInRole($AdministratorRole)) {
    throw "Defender initialization requires an elevated Windows session."
  }
}

function Enable-RequiredService {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Name
  )

  $Service = Get-Service -Name $Name -ErrorAction Stop
  if ($Service.StartType -eq [System.ServiceProcess.ServiceStartMode]::Disabled) {
    Set-Service -Name $Name -StartupType Manual
  }
  if ($Service.Status -ne [System.ServiceProcess.ServiceControllerStatus]::Running) {
    Start-Service -Name $Name
  }

  $Service = Get-Service -Name $Name -ErrorAction Stop
  $Service.WaitForStatus(
    [System.ServiceProcess.ServiceControllerStatus]::Running,
    [TimeSpan]::FromSeconds(30)
  )
}

function Get-ConfiguredValues {
  param(
    [Parameter(Mandatory = $true)]
    [object]$Preference,

    [Parameter(Mandatory = $true)]
    [string]$Property
  )

  return @(
    $Preference.$Property |
      Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) }
  )
}

function Get-MpCmdRunPath {
  $PlatformRoot = Join-Path $env:ProgramData "Microsoft\Windows Defender\Platform"
  if (Test-Path -LiteralPath $PlatformRoot -PathType Container) {
    $PlatformCandidates = @(
      Get-ChildItem -LiteralPath $PlatformRoot -Directory |
        Sort-Object Name -Descending |
        ForEach-Object { Join-Path $_.FullName "MpCmdRun.exe" } |
        Where-Object { Test-Path -LiteralPath $_ -PathType Leaf }
    )
    if ($PlatformCandidates.Count -gt 0) {
      return $PlatformCandidates[0]
    }
  }

  $InboxCandidate = Join-Path $env:ProgramFiles "Windows Defender\MpCmdRun.exe"
  if (Test-Path -LiteralPath $InboxCandidate -PathType Leaf) {
    return $InboxCandidate
  }

  throw "The current Microsoft Defender command-line tool could not be found."
}

function Invoke-MpCmdRun {
  param(
    [Parameter(Mandatory = $true)]
    [string]$FilePath,

    [Parameter(Mandatory = $true)]
    [string[]]$Arguments
  )

  $Output = @(& $FilePath @Arguments 2>&1)
  $ExitCode = $LASTEXITCODE
  foreach ($Line in $Output) {
    Write-Host $Line
  }
  return [ordered]@{
    ExitCode = $ExitCode
    Output = @($Output | ForEach-Object { [string]$_ })
  }
}

function Get-DetectionIds {
  return @(
    Get-MpThreatDetection -ErrorAction SilentlyContinue |
      ForEach-Object { [string]$_.DetectionID } |
      Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
  )
}

function Assert-DetectionSmokeTest {
  param(
    [Parameter(Mandatory = $true)]
    [string]$MpCmdRunPath
  )

  $TestDirectory = Join-Path (
    [System.IO.Path]::GetTempPath()
  ) "tailchrome-defender-smoke-$([Guid]::NewGuid().ToString('N'))"
  $TestPath = Join-Path $TestDirectory "eicar.txt"
  $BaselineDetectionIds = @(Get-DetectionIds)

  New-Item -ItemType Directory -Force -Path $TestDirectory | Out-Null
  try {
    $ExclusionResult = Invoke-MpCmdRun `
      -FilePath $MpCmdRunPath `
      -Arguments @("-CheckExclusion", "-Path", $TestPath)
    if ([int]$ExclusionResult.ExitCode -eq 0) {
      throw "The Defender smoke-test path is excluded from scanning."
    }
    if ([int]$ExclusionResult.ExitCode -ne 1) {
      throw "Defender returned an unexpected exclusion-check exit code: $($ExclusionResult.ExitCode)."
    }

    # Split the standard harmless test signature so the repository itself does
    # not contain the complete detection string.
    $SignaturePrefix = 'X5O!P%@AP[4\PZX54(P^)7CC)7}'
    $SignatureSuffix = '$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*'
    try {
      [System.IO.File]::WriteAllText(
        $TestPath,
        "$SignaturePrefix$SignatureSuffix",
        [System.Text.Encoding]::ASCII
      )
    } catch {
      Write-Host "Real-time protection blocked the smoke-test write: $($_.Exception.Message)"
    }

    if (Test-Path -LiteralPath $TestPath -PathType Leaf) {
      $ScanResult = Invoke-MpCmdRun `
        -FilePath $MpCmdRunPath `
        -Arguments @("-Scan", "-ScanType", "3", "-File", $TestPath)
      if ([int]$ScanResult.ExitCode -notin @(0, 2)) {
        throw "Defender returned an unexpected smoke-test scan exit code: $($ScanResult.ExitCode)."
      }
    }

    $DetectionDeadline = [DateTime]::UtcNow.AddSeconds(60)
    do {
      $SmokeDetections = @(
        Get-MpThreatDetection -ErrorAction SilentlyContinue |
          Where-Object {
            $DetectionId = [string]$_.DetectionID
            $Resources = [string]::Join("`n", @($_.Resources))
            $BaselineDetectionIds -notcontains $DetectionId -and
              $Resources.IndexOf(
                $TestPath,
                [System.StringComparison]::OrdinalIgnoreCase
              ) -ge 0
          }
      )
      if ($SmokeDetections.Count -gt 0 -and
          -not (Test-Path -LiteralPath $TestPath -PathType Leaf)) {
        break
      }
      Start-Sleep -Seconds 2
    } while ([DateTime]::UtcNow -lt $DetectionDeadline)

    if ($SmokeDetections.Count -eq 0) {
      throw "Defender did not record the harmless smoke-test detection."
    }
    if (Test-Path -LiteralPath $TestPath -PathType Leaf) {
      throw "Defender did not quarantine the harmless smoke-test file."
    }
  } finally {
    Remove-Item -LiteralPath $TestDirectory -Recurse -Force -ErrorAction SilentlyContinue
  }
}

function Remove-ScanExclusions {
  $Preference = Get-MpPreference
  foreach ($Property in @("ExclusionPath", "ExclusionExtension", "ExclusionProcess")) {
    $Values = @(Get-ConfiguredValues -Preference $Preference -Property $Property)
    if ($Values.Count -eq 0) {
      continue
    }

    Write-Host "Removing Defender $Property values that could bypass candidate scanning..."
    $Parameters = @{}
    $Parameters[$Property] = $Values
    Remove-MpPreference @Parameters
  }
}

function Get-Readiness {
  $Service = Get-Service -Name WinDefend -ErrorAction Stop
  $Status = Get-MpComputerStatus
  $Preference = Get-MpPreference
  $PathExclusions = @(Get-ConfiguredValues -Preference $Preference -Property "ExclusionPath")
  $ExtensionExclusions = @(
    Get-ConfiguredValues -Preference $Preference -Property "ExclusionExtension"
  )
  $ProcessExclusions = @(
    Get-ConfiguredValues -Preference $Preference -Property "ExclusionProcess"
  )
  $Problems = [System.Collections.Generic.List[string]]::new()

  if ($Service.Status -ne [System.ServiceProcess.ServiceControllerStatus]::Running) {
    $Problems.Add("WinDefend service is not running.")
  }
  if ([string]$Status.AMRunningMode -cne "Normal") {
    $Problems.Add("Defender is not in active mode.")
  }
  if (-not [bool]$Status.AMServiceEnabled) {
    $Problems.Add("Defender antimalware service is not enabled.")
  }
  if (-not [bool]$Status.AntivirusEnabled) {
    $Problems.Add("Defender antivirus is not enabled.")
  }
  if (-not [bool]$Status.RealTimeProtectionEnabled) {
    $Problems.Add("Defender real-time protection is not enabled.")
  }
  if (-not [bool]$Status.BehaviorMonitorEnabled) {
    $Problems.Add("Defender behavior monitoring is not enabled.")
  }
  if (-not [bool]$Status.IoavProtectionEnabled) {
    $Problems.Add("Defender downloaded-file scanning is not enabled.")
  }
  if (-not [bool]$Status.OnAccessProtectionEnabled) {
    $Problems.Add("Defender on-access protection is not enabled.")
  }
  if ([bool]$Preference.DisableRealtimeMonitoring) {
    $Problems.Add("The real-time monitoring preference is disabled.")
  }
  if ([bool]$Preference.DisableBehaviorMonitoring) {
    $Problems.Add("The behavior monitoring preference is disabled.")
  }
  if ([bool]$Preference.DisableIOAVProtection) {
    $Problems.Add("The downloaded-file scanning preference is disabled.")
  }
  if ([bool]$Preference.DisableIntrusionPreventionSystem) {
    $Problems.Add("The intrusion prevention preference is disabled.")
  }
  if ([bool]$Preference.DisableScriptScanning) {
    $Problems.Add("The script scanning preference is disabled.")
  }
  if ([bool]$Preference.DisableArchiveScanning) {
    $Problems.Add("The archive scanning preference is disabled.")
  }
  if ([bool]$Preference.DisableBlockAtFirstSeen) {
    $Problems.Add("Block at first sight is disabled.")
  }
  if (-not [bool]$Preference.DisableAutoExclusions) {
    $Problems.Add("Automatic Windows Server exclusions are enabled.")
  }
  if ([int]$Preference.MAPSReporting -ne 2) {
    $Problems.Add("Advanced cloud-delivered protection is not enabled.")
  }
  if ([int]$Preference.SubmitSamplesConsent -ne 1) {
    $Problems.Add("Automatic safe-sample submission is not enabled.")
  }
  if ([int]$Preference.PUAProtection -ne 1) {
    $Problems.Add("Potentially unwanted application protection is not enabled.")
  }
  if (-not [bool]$Preference.CheckForSignaturesBeforeRunningScan) {
    $Problems.Add("Definition updates before scans are not enabled.")
  }
  if ([bool]$Preference.SignatureDisableUpdateOnStartupWithoutEngine) {
    $Problems.Add("Definition updates without a loaded engine are disabled.")
  }
  if ($null -eq $Status.AntivirusSignatureLastUpdated) {
    $Problems.Add("Defender has no antivirus signature update timestamp.")
  } elseif ([int]$Status.AntivirusSignatureAge -gt 1) {
    $Problems.Add("Defender antivirus signatures are more than one day old.")
  }
  if ($PathExclusions.Count -ne 0) {
    $Problems.Add("Defender still has filesystem path exclusions.")
  }
  if ($ExtensionExclusions.Count -ne 0) {
    $Problems.Add("Defender still has file-extension exclusions.")
  }
  if ($ProcessExclusions.Count -ne 0) {
    $Problems.Add("Defender still has process exclusions.")
  }

  return [ordered]@{
    Ready = $Problems.Count -eq 0
    Problems = @($Problems)
    Service = $Service
    Status = $Status
    Preference = $Preference
  }
}

Assert-ElevatedSession

$PassiveModePolicy = "HKLM:\SOFTWARE\Policies\Microsoft\Windows Advanced Threat Protection"
if (Test-Path -LiteralPath $PassiveModePolicy) {
  $PassiveModeValue = Get-ItemPropertyValue `
    -LiteralPath $PassiveModePolicy `
    -Name "ForceDefenderPassiveMode" `
    -ErrorAction SilentlyContinue
  if ($null -ne $PassiveModeValue -and [int]$PassiveModeValue -ne 0) {
    throw "ForceDefenderPassiveMode is enabled; returning Defender to active mode requires a runner reboot."
  }
}

# The hosted Windows image disables these settings during image construction.
# Re-enable them explicitly so a clean scan is evidence of active protection.
Enable-RequiredService -Name "WinDefend"
Enable-RequiredService -Name "wuauserv"

$RequiredPreferences = @{
  CheckForSignaturesBeforeRunningScan = $true
  DisableArchiveScanning = $false
  DisableAutoExclusions = $true
  DisableBehaviorMonitoring = $false
  DisableBlockAtFirstSeen = $false
  DisableIntrusionPreventionSystem = $false
  DisableIOAVProtection = $false
  DisableRealtimeMonitoring = $false
  DisableScriptScanning = $false
  MAPSReporting = 2
  PUAProtection = 1
  SignatureDisableUpdateOnStartupWithoutEngine = $false
  SubmitSamplesConsent = 1
}
Set-MpPreference @RequiredPreferences
Remove-ScanExclusions

$Updated = $false
$UpdateFailures = [System.Collections.Generic.List[string]]::new()
foreach ($Source in @("MicrosoftUpdateServer", "MMPC")) {
  try {
    Write-Host "Updating Defender security intelligence from $Source..."
    Update-MpSignature -UpdateSource $Source
    $Updated = $true
    break
  } catch {
    $UpdateFailures.Add("$Source`: $($_.Exception.Message)")
  }
}
if (-not $Updated) {
  throw "Defender security intelligence update failed: $($UpdateFailures -join '; ')"
}

$MpCmdRunPath = Get-MpCmdRunPath
$MapsResult = Invoke-MpCmdRun `
  -FilePath $MpCmdRunPath `
  -Arguments @("-ValidateMapsConnection")
if ([int]$MapsResult.ExitCode -ne 0) {
  throw "Defender cloud connectivity validation failed with exit code $($MapsResult.ExitCode)."
}

$Deadline = [DateTime]::UtcNow.AddSeconds($ReadinessTimeoutSeconds)
do {
  $Readiness = Get-Readiness
  if ($Readiness.Ready) {
    break
  }
  Start-Sleep -Seconds 2
} while ([DateTime]::UtcNow -lt $Deadline)

if (-not $Readiness.Ready) {
  throw "Active Defender readiness could not be proven: $($Readiness.Problems -join ' ')"
}

if ($RunDetectionSmokeTest) {
  Assert-DetectionSmokeTest -MpCmdRunPath $MpCmdRunPath
}

$ReadyStatus = $Readiness.Status
$ReadyPreference = $Readiness.Preference
$Summary = [ordered]@{
  serviceStatus = $Readiness.Service.Status.ToString()
  antimalwareRunningMode = [string]$ReadyStatus.AMRunningMode
  antivirusEnabled = [bool]$ReadyStatus.AntivirusEnabled
  realTimeProtectionEnabled = [bool]$ReadyStatus.RealTimeProtectionEnabled
  behaviorMonitorEnabled = [bool]$ReadyStatus.BehaviorMonitorEnabled
  ioavProtectionEnabled = [bool]$ReadyStatus.IoavProtectionEnabled
  onAccessProtectionEnabled = [bool]$ReadyStatus.OnAccessProtectionEnabled
  mapsReporting = [int]$ReadyPreference.MAPSReporting
  submitSamplesConsent = [int]$ReadyPreference.SubmitSamplesConsent
  puaProtection = [int]$ReadyPreference.PUAProtection
  mapsConnectionValidated = $true
  mapsValidationExitCode = [int]$MapsResult.ExitCode
  securityIntelligenceUpdateSource = $Source
  antivirusSignatureVersion = [string]$ReadyStatus.AntivirusSignatureVersion
  antivirusSignatureAge = [int]$ReadyStatus.AntivirusSignatureAge
  antivirusSignatureLastUpdated = (
    $ReadyStatus.AntivirusSignatureLastUpdated.ToUniversalTime().ToString("o")
  )
  detectionSmokeTestPassed = [bool]$RunDetectionSmokeTest
}
$SummaryJson = $Summary | ConvertTo-Json
if (-not [string]::IsNullOrWhiteSpace($SummaryPath)) {
  $SummaryPath = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath(
    $SummaryPath
  )
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $SummaryPath) | Out-Null
  Set-Content -LiteralPath $SummaryPath -Value $SummaryJson -Encoding utf8NoBOM
}
$SummaryJson | Write-Host
