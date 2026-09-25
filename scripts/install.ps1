#requires -Version 5.1
<#
.SYNOPSIS
  Installs Tailchrome's per-user Windows helper from a verified release.
#>
[CmdletBinding()]
param(
  [string]$Version,
  [switch]$Uninstall,
  [string]$BinDir,
  [switch]$AllowUnsigned
)

$ErrorActionPreference = 'Stop'
$Repository = 'dantraynor/tailchrome'
$ReleaseBaseDefault = "https://github.com/$Repository/releases/download"
$InstallerSourcePath = ''
if ($PSCommandPath) {
  try {
    $InstallerSourcePath = [System.IO.Path]::GetFullPath($PSCommandPath)
  } catch {
    $InstallerSourcePath = ''
  }
}

function Assert-SupportedPlatform {
  $windows = $false
  $isWindowsVariable = Get-Variable -Name IsWindows -ErrorAction SilentlyContinue
  if ($isWindowsVariable) {
    $windows = [bool]$isWindowsVariable.Value
  } else {
    try {
      $windows = [System.Runtime.InteropServices.RuntimeInformation]::IsOSPlatform(
        [System.Runtime.InteropServices.OSPlatform]::Windows)
    } catch {
      $windows = ([Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT)
    }
  }
  if (-not $windows) {
    throw 'This installer supports Windows only.'
  }
}

function Fail([string]$Message) {
  throw $Message
}

function Assert-SafeVersion([string]$Candidate) {
  if ($Candidate -notmatch '^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$') {
    Fail "Version must be an explicit release tag such as v1.2.3: $Candidate"
  }
}

function ConvertTo-PowerShellLiteral([string]$Value) {
  return "'" + $Value.Replace("'", "''") + "'"
}

function Get-UninstallCommand([string]$Version, [string]$TargetDirectory, [string]$SourcePath) {
  Assert-SafeVersion $Version
  $versionLiteral = ConvertTo-PowerShellLiteral $Version
  $directoryLiteral = ConvertTo-PowerShellLiteral $TargetDirectory
  if ($SourcePath -and (Test-Path -LiteralPath $SourcePath -PathType Leaf)) {
    $pathLiteral = ConvertTo-PowerShellLiteral $SourcePath
    return "& $pathLiteral -Version $versionLiteral -BinDir $directoryLiteral -Uninstall"
  }
  $installerUri = "$ReleaseBaseDefault/$Version/tailchrome-install.ps1"
  if ($installerUri -notmatch '^https://') {
    Fail "Installer removal URL must use HTTPS: $installerUri"
  }
  $uriLiteral = ConvertTo-PowerShellLiteral $installerUri
  return "& ([scriptblock]::Create((Invoke-RestMethod -UseBasicParsing -Uri $uriLiteral))) -Version $versionLiteral -BinDir $directoryLiteral -Uninstall"
}

function Get-NativeArchitecture {
  # PROCESSOR_ARCHITECTURE describes the current PowerShell process. On
  # ARM64 Windows a 32/64-bit emulated shell can report AMD64, so ask the OS
  # for the native machine first (IsWow64Process2 is available on supported
  # modern Windows and the environment fallback covers older versions).
  try {
    if (-not ('TailchromeNativeMethods' -as [type])) {
      Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class TailchromeNativeMethods {
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool IsWow64Process2(IntPtr process, out ushort processMachine, out ushort nativeMachine);
}
'@
    }
    [UInt16]$processMachine = 0
    [UInt16]$nativeMachine = 0
    $handle = [Diagnostics.Process]::GetCurrentProcess().Handle
    if ([TailchromeNativeMethods]::IsWow64Process2($handle, [ref]$processMachine, [ref]$nativeMachine) -and $nativeMachine -ne 0) {
      switch ($nativeMachine) {
        0xAA64 { return 'arm64' }
        0x8664 { return 'amd64' }
      }
    }
  } catch {
    # Fall through to the compatible environment-based detection.
  }
  $architecture = if ($env:PROCESSOR_ARCHITEW6432) {
    $env:PROCESSOR_ARCHITEW6432
  } else {
    $env:PROCESSOR_ARCHITECTURE
  }
  switch ($architecture.ToUpperInvariant()) {
    'AMD64' { return 'amd64' }
    'ARM64' { return 'arm64' }
    default { Fail "Unsupported Windows architecture: $architecture" }
  }
}

function Get-ReleaseTag {
  $latestUrl = "https://api.github.com/repos/$Repository/releases/latest"
  $response = Invoke-WebRequest -UseBasicParsing -Uri $latestUrl
  $release = $response.Content | ConvertFrom-Json
  if (-not $release.tag_name -or @($release.PSObject.Properties.Name | Where-Object { $_ -eq 'tag_name' }).Count -ne 1) {
    Fail 'Latest release response did not contain one tag_name.'
  }
  Assert-SafeVersion $release.tag_name
  return [string]$release.tag_name
}

function Get-Checksum([string]$ManifestPath, [string]$AssetName) {
  $checksumMatches = New-Object 'System.Collections.Generic.List[string]'
  foreach ($line in ((Get-Content -LiteralPath $ManifestPath -Raw) -split '\r?\n')) {
    if ([string]::IsNullOrEmpty($line)) {
      continue
    }
    if ($line -notmatch '^(?<hash>[0-9a-fA-F]{64})[ \t]+\*?(?<name>[A-Za-z0-9][A-Za-z0-9._-]*)$') {
      Fail 'SHA256SUMS.txt contains an unsafe or malformed entry.'
    }
    $name = [string]$Matches.name
    if ($name.Contains('..') -or [System.IO.Path]::IsPathRooted($name)) {
      Fail 'SHA256SUMS.txt contains an unsafe filename.'
    }
    if ($name -ceq $AssetName) {
      $checksumMatches.Add($Matches.hash.ToLowerInvariant())
    }
  }
  if ($checksumMatches.Count -ne 1) {
    Fail "Expected exactly one checksum entry for $AssetName."
  }
  return $checksumMatches[0]
}

function Get-Sha256Hex([string]$Path) {
  $algorithm = [System.Security.Cryptography.SHA256]::Create()
  $stream = $null
  try {
    $stream = [System.IO.File]::OpenRead($Path)
    return ([BitConverter]::ToString($algorithm.ComputeHash($stream))).Replace('-', '').ToLowerInvariant()
  } finally {
    if ($stream) { $stream.Dispose() }
    $algorithm.Dispose()
  }
}

function Invoke-Download([string]$Uri, [string]$Path) {
  if ($Uri -notmatch '^https://') {
    Fail "Release URL must use HTTPS: $Uri"
  }
  Invoke-WebRequest -UseBasicParsing -Uri $Uri -OutFile $Path
}

function Test-AvailableAttestation([string]$ArtifactPath) {
  $gh = Get-Command gh -ErrorAction SilentlyContinue
  if (-not $gh) {
    Write-Warning 'GitHub CLI attestation verification is unavailable; the checksum and artifact share the GitHub Release trust boundary.'
    return
  }
  & $gh.Source attestation verify --help *> $null
  if ($LASTEXITCODE -ne 0) {
    Write-Warning 'GitHub CLI attestation verification is unavailable; the checksum and artifact share the GitHub Release trust boundary.'
    return
  }
  & $gh.Source auth status --hostname github.com *> $null
  if ($LASTEXITCODE -ne 0) {
    Write-Warning 'GitHub CLI is not authenticated; the checksum and artifact share the GitHub Release trust boundary.'
    return
  }
  & $gh.Source attestation verify $ArtifactPath --hostname github.com --repo $Repository *> $null
  if ($LASTEXITCODE -ne 0) {
    Fail 'GitHub artifact attestation verification failed.'
  }
}

function Test-Authenticode([string]$ArtifactPath) {
  $signatureCommand = Get-Command Get-AuthenticodeSignature -ErrorAction SilentlyContinue
  if (-not $signatureCommand) {
    if ($AllowUnsigned -or $env:TAILCHROME_ALLOW_UNSIGNED_RELEASE -eq '1') {
      Write-Warning 'Authenticode verification is unavailable; proceeding only because unsigned release mode was explicitly enabled.'
      return
    }
    Fail 'Authenticode verification is unavailable; use -AllowUnsigned only for an explicitly approved unsigned release.'
  }
  $signature = Get-AuthenticodeSignature -LiteralPath $ArtifactPath
  if ($signature.Status -eq 'Valid') {
    return
  }
  if ($signature.Status -eq 'NotSigned' -and ($AllowUnsigned -or $env:TAILCHROME_ALLOW_UNSIGNED_RELEASE -eq '1')) {
    Write-Warning 'The release is unsigned; proceeding only because unsigned release mode was explicitly enabled.'
    return
  }
  if ($signature.Status -eq 'NotSigned') {
    Fail 'Release is unsigned; use -AllowUnsigned only for an explicitly approved unsigned release.'
  }
  Fail "Windows signature verification failed: $($signature.Status)."
}

function Open-InstallLock([string]$LockPath) {
  try {
    return [System.IO.File]::Open($LockPath, [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
  } catch {
    Fail "Another Tailchrome installation is already in progress: $LockPath"
  }
}

function Open-DestinationWriteHandle([string]$Destination) {
  if (-not (Test-Path -LiteralPath $Destination -PathType Leaf)) {
    return $null
  }
  $item = Get-Item -LiteralPath $Destination -Force
  if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    Fail "Refusing to replace a mapped or reparse-point destination: $Destination"
  }
  try {
    # A mapped/running Windows image normally denies this write-capable handle.
    # Keep it open through File.Replace: Read|Delete sharing makes the replace
    # itself the race-safe write operation, rather than a check followed by a
    # window in which another process can map the image.
    return [System.IO.File]::Open(
      $Destination,
      [System.IO.FileMode]::Open,
      [System.IO.FileAccess]::ReadWrite,
      ([System.IO.FileShare]::Read -bor [System.IO.FileShare]::Delete))
  } catch {
    Fail "Destination is in use or mapped by another process: $Destination"
  }
}

function Copy-VerifiedStage([string]$Source, [string]$Destination) {
  $inputStream = $null
  $outputStream = $null
  try {
    $inputStream = [System.IO.File]::OpenRead($Source)
    $outputStream = [System.IO.File]::Open($Destination, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
    $inputStream.CopyTo($outputStream)
    $outputStream.Flush($true)
  } finally {
    if ($outputStream) { $outputStream.Dispose() }
    if ($inputStream) { $inputStream.Dispose() }
  }
}

function Invoke-InstalledHelper([string]$Path, [string[]]$Arguments) {
  try {
    & $Path @Arguments | Out-Host
  } catch {
    throw [System.InvalidOperationException]::new(
      "Windows could not start the helper at '$Path'. Check Windows Security > Protection history for a detection. -AllowUnsigned only permits an absent signature; it does not override antivirus protection. See https://github.com/dantraynor/tailchrome/blob/main/docs/helper-installation.md#windows-security-blocks-the-helper . Original error: $($_.Exception.Message)",
      $_.Exception)
  }
  $exitCode = $LASTEXITCODE
  return [int]$exitCode
}

function Restore-Backup([string]$BackupPath, [string]$Destination) {
  if (Test-Path -LiteralPath $Destination) {
    $replacedFileBackup = $Destination + '.tailchrome-recovery-' + [guid]::NewGuid().ToString('N')
    [System.IO.File]::Replace($BackupPath, $Destination, $replacedFileBackup, $true)
    Remove-Item -LiteralPath $replacedFileBackup -Force -ErrorAction SilentlyContinue
  } else {
    [System.IO.File]::Move($BackupPath, $Destination)
  }
}

function Invoke-TailchromeInstaller {
param(
  [string]$Version,
  [switch]$Uninstall,
  [string]$BinDir,
  [switch]$AllowUnsigned
)
Assert-SupportedPlatform
$architecture = Get-NativeArchitecture
$asset = "tailscale-browser-ext-windows-$architecture.exe"
$localAppData = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) '' }
$targetDirectory = if ($BinDir) { [System.IO.Path]::GetFullPath($BinDir) } else { Join-Path $localAppData 'Tailchrome' }
if ($targetDirectory.Contains([Environment]::NewLine)) {
  Fail "Install directory contains a newline: $targetDirectory"
}
New-Item -ItemType Directory -Path $targetDirectory -Force | Out-Null
if ((Get-Item -LiteralPath $targetDirectory).Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
  Fail "Install directory is a reparse point: $targetDirectory"
}
$destination = Join-Path $targetDirectory 'tailchrome.exe'
$lockPath = Join-Path $targetDirectory '.tailchrome-install.lock'
$lock = Open-InstallLock $lockPath
$tempDirectory = $null
$stagePath = $null
$backupPath = $null
$destinationHandle = $null
$hadDestination = Test-Path -LiteralPath $destination -PathType Leaf
$activated = $false
$preserveBackup = $false

try {
  if ($Uninstall) {
    if (-not $hadDestination) {
      Fail "Installed helper not found at $destination"
    }
    $uninstallHandle = Open-DestinationWriteHandle $destination
    if ($uninstallHandle) { $uninstallHandle.Dispose() }
    $uninstallExitCode = Invoke-InstalledHelper $destination @('uninstall', '--binary-path', $destination)
    if ($uninstallExitCode -ne 0) {
      Fail "Uninstall registration failed; leaving $destination in place."
    }
    Remove-Item -LiteralPath $destination -Force
    Write-Output "Uninstalled helper from: $destination"
    return
  }

  if ($Version) {
    Assert-SafeVersion $Version
  } else {
    $Version = Get-ReleaseTag
  }
  Assert-SafeVersion $Version

$releaseBase = "$ReleaseBaseDefault/$Version"
  if ($releaseBase -notmatch '^https://') {
    Fail "Release URL must use HTTPS: $releaseBase"
  }

  $tempDirectory = Join-Path ([System.IO.Path]::GetTempPath()) ("tailchrome-install-" + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $tempDirectory | Out-Null
  $manifestPath = Join-Path $tempDirectory 'SHA256SUMS.txt'
  $artifactPath = Join-Path $tempDirectory $asset
  Invoke-Download "$releaseBase/SHA256SUMS.txt" $manifestPath
  $expectedHash = Get-Checksum $manifestPath $asset
  Invoke-Download "$releaseBase/$asset" $artifactPath

  $actualHash = Get-Sha256Hex $artifactPath
  if ($actualHash -cne $expectedHash) {
    Fail 'SHA-256 checksum verification failed.'
  }
  Test-AvailableAttestation $artifactPath
  Test-Authenticode $artifactPath

  $stagePath = Join-Path $targetDirectory ('.tailchrome-stage-' + [guid]::NewGuid().ToString('N') + '.tmp')
  Copy-VerifiedStage $artifactPath $stagePath

  if ($hadDestination) {
    $destinationHandle = Open-DestinationWriteHandle $destination
    $backupPath = Join-Path $targetDirectory ('.tailchrome-backup-' + [guid]::NewGuid().ToString('N') + '.tmp')
    try {
      [System.IO.File]::Replace($stagePath, $destination, $backupPath, $true)
    } finally {
      if ($destinationHandle) {
        $destinationHandle.Dispose()
        $destinationHandle = $null
      }
    }
  } else {
    [System.IO.File]::Move($stagePath, $destination)
  }
  $stagePath = $null
  $activated = $true

  $installExitCode = Invoke-InstalledHelper $destination @('install', '--binary-path', $destination)
  if ($installExitCode -ne 0) {
    Fail 'Install registration failed.'
  }

  if ($backupPath -and (Test-Path -LiteralPath $backupPath)) {
    Remove-Item -LiteralPath $backupPath -Force
    $backupPath = $null
  }
  Write-Output "Installed helper: $destination"
  $removalCommand = Get-UninstallCommand $Version $targetDirectory $InstallerSourcePath
  Write-Output "Uninstall with (pinned to $Version): $removalCommand"
} catch {
  $installError = $_
  if ($activated) {
    try {
      if (-not $hadDestination -and (Test-Path -LiteralPath $destination)) {
        # The host's direct-registration transaction owns manifest rollback.
        # Do not unregister here: that could remove registrations belonging to
        # another installation method which the host has already restored.
        Remove-Item -LiteralPath $destination -Force
      } elseif ($hadDestination -and $backupPath -and (Test-Path -LiteralPath $backupPath)) {
        Restore-Backup $backupPath $destination
        $backupPath = $null
      }
    } catch {
      $preserveBackup = $true
      Write-Warning "Rollback failed after installer error; recovery copy was retained: $($_.Exception.Message)"
    }
  } elseif ($backupPath -and (Test-Path -LiteralPath $backupPath)) {
    # File.Replace can create its backup before reporting an activation error.
    # Restore it even though activation was not marked complete.
    try {
      Restore-Backup $backupPath $destination
      $backupPath = $null
    } catch {
      $preserveBackup = $true
      Write-Warning "Activation rollback failed; recovery copy was retained: $($_.Exception.Message)"
    }
  }
  # Defender can also quarantine a download or staging file before execution.
  # Use Win32 error codes so this works with localized Windows installations.
  $failure = $installError.Exception
  while ($failure) {
    $code = $failure.HResult -band 0xffff
    if ($failure -is [System.ComponentModel.Win32Exception]) { $code = $failure.NativeErrorCode }
    if ($code -eq 225 -or $code -eq 226) {
      throw [System.InvalidOperationException]::new(
        "Windows antivirus blocked or quarantined the Tailchrome helper. Check Windows Security > Protection history and report the detection with the release version and SHA-256 hash. -AllowUnsigned does not override antivirus protection. See https://github.com/dantraynor/tailchrome/blob/main/docs/helper-installation.md#windows-security-blocks-the-helper . Original error: $($installError.Exception.Message)",
        $installError.Exception)
    }
    $failure = $failure.InnerException
  }
  throw $installError
} finally {
  if ($destinationHandle) {
    $destinationHandle.Dispose()
  }
  if ($stagePath -and (Test-Path -LiteralPath $stagePath)) {
    Remove-Item -LiteralPath $stagePath -Force -ErrorAction SilentlyContinue
  }
  if (-not $preserveBackup -and $backupPath -and (Test-Path -LiteralPath $backupPath)) {
    Remove-Item -LiteralPath $backupPath -Force -ErrorAction SilentlyContinue
  }
  if ($tempDirectory -and (Test-Path -LiteralPath $tempDirectory)) {
    Remove-Item -LiteralPath $tempDirectory -Recurse -Force -ErrorAction SilentlyContinue
  }
  if ($lock) {
    $lock.Dispose()
  }
}

}

# Dot-sourcing defines the implementation without performing network, file, or
# platform work. The one-liner and normal -File invocation execute the entrypoint.
if ($MyInvocation.InvocationName -ne '.') {
  Invoke-TailchromeInstaller -Version $Version -Uninstall:$Uninstall -BinDir $BinDir -AllowUnsigned:$AllowUnsigned
}
