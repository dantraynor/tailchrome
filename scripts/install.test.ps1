# Fixture tests for install.ps1. They use dot-sourced implementation functions and
# arbitrary verified bytes, so they run on pwsh without a native Windows payload.
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
$Installer = Join-Path $Root 'scripts/install.ps1'
. $Installer
$ProductionInvokeInstalledHelper = (Get-Command Invoke-InstalledHelper -CommandType Function).ScriptBlock
$ProductionGetNativeArchitecture = (Get-Command Get-NativeArchitecture -CommandType Function).ScriptBlock

$TestsRun = 0
$TestsFailed = 0
$Fixture = $null
$TestArch = 'amd64'
$SignatureStatus = 'NotSigned'
$RegisterFail = $false
$BlockedStage = ''
$UnregisterCalls = 0
$LastDownload = ''
$WindowsTest = ([Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT)

function Pass([string]$Name) {
  $script:TestsRun++
  Write-Output "ok $script:TestsRun - $Name"
}
function FailTest([string]$Name, [string]$Detail) {
  $script:TestsRun++
  $script:TestsFailed++
  Write-Output "not ok $script:TestsRun - $Name"
  Write-Output "  $Detail"
}
function New-Fixture {
  if ($script:Fixture) { Remove-Item -LiteralPath $script:Fixture -Recurse -Force -ErrorAction SilentlyContinue }
  $script:Fixture = Join-Path ([IO.Path]::GetTempPath()) ('tailchrome-ps-test-' + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $script:Fixture | Out-Null
  New-Item -ItemType Directory -Path (Join-Path $script:Fixture 'local') | Out-Null
  $script:TestArch = 'amd64'
  $script:SignatureStatus = 'NotSigned'
  $script:RegisterFail = $false
  $script:BlockedStage = ''
  $script:UnregisterCalls = 0
  $script:LastDownload = ''
  $env:LOCALAPPDATA = Join-Path $script:Fixture 'local'
  Set-Content -LiteralPath (Join-Path $script:Fixture 'artifact') -Value 'old' -NoNewline
  Set-Manifest
}
function Set-Manifest {
  $asset = 'tailscale-browser-ext-windows-' + $script:TestArch + '.exe'
  $hash = Get-Sha256Hex (Join-Path $script:Fixture 'artifact')
  "$hash  $asset" | Set-Content -LiteralPath (Join-Path $script:Fixture 'manifest')
}
function Assert-SupportedPlatform { }
function Get-NativeArchitecture { return $script:TestArch }
function Invoke-Download([string]$Uri, [string]$Path) {
  $script:LastDownload = $Uri
  if ($script:BlockedStage -eq 'download' -and $Uri.EndsWith('.exe')) { throw [System.ComponentModel.Win32Exception]::new(225) }
  if ($Uri.EndsWith('/SHA256SUMS.txt')) {
    Copy-Item -LiteralPath (Join-Path $script:Fixture 'manifest') -Destination $Path
  } else {
    Copy-Item -LiteralPath (Join-Path $script:Fixture 'artifact') -Destination $Path
  }
}
function Test-AvailableAttestation([string]$ArtifactPath) { }
function Get-AuthenticodeSignature([string]$LiteralPath) {
  return [pscustomobject]@{ Status = $script:SignatureStatus }
}
function Invoke-InstalledHelper([string]$Path, [string[]]$Arguments) {
  if ($Arguments[0] -eq 'uninstall') {
    $script:UnregisterCalls++
    return 0
  }
  if ($script:BlockedStage -eq 'execute') {
    Remove-Item -LiteralPath $Path -Force
    throw [System.ComponentModel.Win32Exception]::new(226)
  }
  if ($script:RegisterFail) { return 9 }
  $script:LastHelperPath = $Path
  return 0
}
function Invoke-Main([switch]$AllowUnsigned, [switch]$Uninstall, [string]$Version = 'v1.2.3') {
  try {
    Invoke-TailchromeInstaller -Version $Version -Uninstall:$Uninstall -AllowUnsigned:$AllowUnsigned | Out-Null
    return $null
  } catch {
    return $_.Exception.Message
  }
}
function Expect-Failure([string]$Name, [string]$Expected, [scriptblock]$Action) {
  $message = & $Action
  if ($message -and $message -like ('*' + $Expected + '*')) {
    Pass $Name
  } else {
    FailTest $Name ('expected reason containing [' + $Expected + '], got [' + $message + ']')
  }
}
function New-InstallerFixtureSource([string]$BinDir) {
  $source = Get-Content -LiteralPath $Installer -Raw
  $source = [regex]::Replace($source, '(?s)\r?\n# Dot-sourcing defines.*\z', '')
  $manifestLiteral = ConvertTo-PowerShellLiteral (Join-Path $script:Fixture 'manifest')
  $artifactLiteral = ConvertTo-PowerShellLiteral (Join-Path $script:Fixture 'artifact')
  $logLiteral = ConvertTo-PowerShellLiteral (Join-Path $script:Fixture 'exec.log')
  $binLiteral = ConvertTo-PowerShellLiteral $BinDir
  $overrides = @'
function Assert-SupportedPlatform { }
function Get-NativeArchitecture { return 'amd64' }
function Invoke-Download([string]$Uri, [string]$Path) {
  if ($Uri.EndsWith('/SHA256SUMS.txt')) {
    Copy-Item -LiteralPath __MANIFEST__ -Destination $Path
  } else {
    Copy-Item -LiteralPath __ARTIFACT__ -Destination $Path
  }
}
function Test-AvailableAttestation([string]$ArtifactPath) { }
function Get-AuthenticodeSignature([string]$LiteralPath) {
  return [pscustomobject]@{ Status = 'NotSigned' }
}
function Invoke-InstalledHelper([string]$Path, [string[]]$Arguments) {
  Add-Content -LiteralPath __LOG__ -Value ($Arguments -join ' ')
  if ($Arguments[0] -eq 'uninstall' -and $env:TAILCHROME_PS_REPLAY_UNREGISTER_FAIL -eq '1') {
    return 8
  }
  return 0
}
'@
  $overrides = $overrides.Replace('__MANIFEST__', $manifestLiteral)
  $overrides = $overrides.Replace('__ARTIFACT__', $artifactLiteral)
  $overrides = $overrides.Replace('__LOG__', $logLiteral)
  $dispatch = @'
Invoke-TailchromeInstaller -Version $Version -Uninstall:$Uninstall -BinDir $BinDir -AllowUnsigned:$AllowUnsigned
'@
  return $source + [Environment]::NewLine + $overrides + [Environment]::NewLine + $dispatch
}

$helperFixture = Join-Path ([IO.Path]::GetTempPath()) ('tailchrome-helper-call-' + [guid]::NewGuid().ToString('N') + '.ps1')
@'
param([string]$Mode)
Write-Output 'helper stdout'
if ($Mode -eq 'failure') { exit 7 }
exit 0
'@ | Set-Content -LiteralPath $helperFixture
$helperSuccess = & $ProductionInvokeInstalledHelper $helperFixture @('success')
$helperFailure = & $ProductionInvokeInstalledHelper $helperFixture @('failure')
Remove-Item -LiteralPath $helperFixture -Force
if ($helperSuccess -eq 0 -and $helperFailure -eq 7) {
  Pass 'keeps helper stdout out of Invoke-InstalledHelper exit-code results'
} else {
  FailTest 'keeps helper stdout out of Invoke-InstalledHelper exit-code results' ("success=[$helperSuccess] failure=[$helperFailure]")
}

New-Fixture
$popupBin = Join-Path $script:Fixture "scriptblock bin/owner's helper"
New-Item -ItemType Directory -Path $popupBin -Force | Out-Null
$script:PopupSource = New-InstallerFixtureSource $popupBin
$popupBlock = [scriptblock]::Create($script:PopupSource)
$popupOutput = (& $popupBlock -Version 'v1.2.3' -BinDir $popupBin -AllowUnsigned 2>&1 | Out-String)
$popupGuidance = ($popupOutput -split '\r?\n' | Where-Object { $_ -like 'Uninstall with (pinned to v1.2.3):*' } | Select-Object -Last 1)
$popupCommand = if ($popupGuidance) { $popupGuidance.Substring($popupGuidance.IndexOf(': ') + 2) } else { '' }
function Invoke-RestMethod([switch]$UseBasicParsing, [string]$Uri) {
  return $script:PopupSource
}
if ($popupCommand -like "*releases/download/v1.2.3/tailchrome-install.ps1*" -and
  $popupCommand -like "*-Version 'v1.2.3' -BinDir '*") {
  $popupDestination = Join-Path $popupBin 'tailchrome.exe'
  $env:TAILCHROME_PS_REPLAY_UNREGISTER_FAIL = '1'
  try {
    $popupFailure = (& ([scriptblock]::Create($popupCommand)) 2>&1 | Out-String)
  } catch {
    $popupFailure = $_.Exception.Message
  }
  if ($popupFailure -and (Test-Path -LiteralPath $popupDestination) -and
    (Get-Content -LiteralPath (Join-Path $script:Fixture 'exec.log') -Raw) -like '*uninstall --binary-path*') {
    Pass 'scriptblock PowerShell guidance preserves binary when unregister fails'
  } else {
    FailTest 'scriptblock PowerShell guidance preserves binary when unregister fails' ($popupFailure -or 'replay did not preserve the binary')
  }
  $env:TAILCHROME_PS_REPLAY_UNREGISTER_FAIL = '0'
  $popupSucceeded = $true
  try {
    $popupSuccess = (& ([scriptblock]::Create($popupCommand)) 2>&1 | Out-String)
  } catch {
    $popupSucceeded = $false
    $popupSuccess = $_.Exception.Message
  }
  if ($popupSucceeded -and -not (Test-Path -LiteralPath $popupDestination)) {
    Pass 'scriptblock PowerShell guidance executes pinned removal with quoted custom directory'
  } else {
    FailTest 'scriptblock PowerShell guidance executes pinned removal with quoted custom directory' ($popupSuccess -or 'replay did not remove the binary')
  }
} else {
  FailTest 'scriptblock PowerShell guidance executes pinned removal with quoted custom directory' ($popupOutput -or 'missing scriptblock guidance')
  FailTest 'scriptblock PowerShell guidance preserves binary when unregister fails' 'setup did not produce a pinned scriptblock command'
}
Remove-Item Function:\Invoke-RestMethod -ErrorAction SilentlyContinue
Remove-Item Env:\TAILCHROME_PS_REPLAY_UNREGISTER_FAIL -ErrorAction SilentlyContinue

New-Fixture
$savedBin = Join-Path $script:Fixture "saved bin/owner's helper"
$savedPath = Join-Path $script:Fixture "saved installer 'copy/install.ps1"
New-Item -ItemType Directory -Path $savedBin -Force | Out-Null
New-Item -ItemType Directory -Path (Split-Path -Parent $savedPath) -Force | Out-Null
$savedSource = New-InstallerFixtureSource $savedBin
Set-Content -LiteralPath $savedPath -Value $savedSource -NoNewline
$savedDestination = Join-Path $savedBin 'tailchrome.exe'
Set-Content -LiteralPath $savedDestination -Value 'old' -NoNewline
$savedInstallSucceeded = $true
try {
  $savedInstallOutput = (& $savedPath -Version 'v1.2.3' -BinDir $savedBin -AllowUnsigned 2>&1 | Out-String)
} catch {
  $savedInstallSucceeded = $false
  $savedInstallOutput = $_.Exception.Message
}
$savedGuidance = ($savedInstallOutput -split '\r?\n' | Where-Object { $_ -like 'Uninstall with (pinned to v1.2.3):*' } | Select-Object -Last 1)
$savedCommand = if ($savedGuidance) { $savedGuidance.Substring($savedGuidance.IndexOf(': ') + 2) } else { '' }
$savedAbsolute = [IO.Path]::GetFullPath($savedPath)
$savedLiteral = ConvertTo-PowerShellLiteral $savedAbsolute
if ($savedInstallSucceeded -and $savedCommand.StartsWith("& $savedLiteral ") -and
  $savedCommand -like "*-Version 'v1.2.3' -BinDir '*") {
  $env:TAILCHROME_PS_REPLAY_UNREGISTER_FAIL = '1'
  try {
    $savedFailure = (& ([scriptblock]::Create($savedCommand)) 2>&1 | Out-String)
  } catch {
    $savedFailure = $_.Exception.Message
  }
  if ($savedFailure -and (Test-Path -LiteralPath $savedDestination)) {
    Pass 'saved PowerShell guidance preserves binary when unregister fails'
  } else {
    FailTest 'saved PowerShell guidance preserves binary when unregister fails' ($savedFailure -or 'saved replay did not preserve the binary')
  }
  $env:TAILCHROME_PS_REPLAY_UNREGISTER_FAIL = '0'
  $savedSucceeded = $true
  try {
    $savedSuccess = (& ([scriptblock]::Create($savedCommand)) 2>&1 | Out-String)
  } catch {
    $savedSucceeded = $false
    $savedSuccess = $_.Exception.Message
  }
  if ($savedSucceeded -and -not (Test-Path -LiteralPath $savedDestination)) {
    Pass 'saved PowerShell guidance uses absolute quoted installer path'
  } else {
    FailTest 'saved PowerShell guidance uses absolute quoted installer path' ($savedSuccess -or 'saved replay did not remove the binary')
  }
} else {
  FailTest 'saved PowerShell guidance uses absolute quoted installer path' ($savedInstallOutput -or 'saved invocation did not emit an explicit call-operator command')
  FailTest 'saved PowerShell guidance preserves binary when unregister fails' 'saved invocation did not produce a replayable command'
}
Remove-Item Env:\TAILCHROME_PS_REPLAY_UNREGISTER_FAIL -ErrorAction SilentlyContinue

New-Fixture
$script:SignatureStatus = 'Invalid'
Expect-Failure 'rejects invalid signature with unsigned opt-in' 'signature verification failed' { Invoke-Main -AllowUnsigned }
New-Fixture
Expect-Failure 'rejects unsigned release without opt-in' 'use -AllowUnsigned' { Invoke-Main }
New-Fixture
$message = Invoke-Main -AllowUnsigned
$destination = Join-Path $env:LOCALAPPDATA 'Tailchrome/tailchrome.exe'
if (-not $message -and (Test-Path -LiteralPath $destination) -and $script:LastHelperPath -eq $destination) {
  Pass 'installs verified bytes at the stable path and invokes the CLI with that path'
} else {
  FailTest 'installs verified bytes at the stable path and invokes the CLI with that path' ($message -or 'missing stable path/CLI evidence')
}

foreach ($stage in @('download', 'execute')) {
  New-Fixture
  $null = Invoke-Main -AllowUnsigned
  $script:BlockedStage = $stage
  Set-Content -LiteralPath (Join-Path $script:Fixture 'artifact') -Value 'new' -NoNewline
  Set-Manifest
  $message = Invoke-Main -AllowUnsigned
  $destination = Join-Path $env:LOCALAPPDATA 'Tailchrome/tailchrome.exe'
  if ($message -like '*antivirus blocked or quarantined*' -and
      $message -like '*-AllowUnsigned does not override antivirus*' -and
      (Get-Content -LiteralPath $destination -Raw) -eq 'old') {
    Pass "reports antivirus block during $stage and preserves the previous helper"
  } else {
    FailTest "reports antivirus block during $stage and preserves the previous helper" $message
  }
}

New-Fixture
$script:RegisterFail = $true
$message = Invoke-Main -AllowUnsigned
if ($message -and -not (Test-Path -LiteralPath (Join-Path $env:LOCALAPPDATA 'Tailchrome/tailchrome.exe')) -and $script:UnregisterCalls -eq 0) {
  Pass 'leaves fresh manifest rollback to the host transaction before removing a failed binary'
} else {
  FailTest 'leaves fresh manifest rollback to the host transaction before removing a failed binary' ($message -or 'fresh rollback unexpectedly changed registration ownership')
}

New-Fixture
$null = Invoke-Main -AllowUnsigned
Set-Content -LiteralPath (Join-Path $script:Fixture 'artifact') -Value 'new' -NoNewline
Set-Manifest
$script:RegisterFail = $true
$message = Invoke-Main -AllowUnsigned
$destination = Join-Path $env:LOCALAPPDATA 'Tailchrome/tailchrome.exe'
if ($message -and (Get-Content -LiteralPath $destination -Raw) -eq 'old') {
  Pass 'restores the previous executable after registration failure'
} else {
  FailTest 'restores the previous executable after registration failure' ($message -or 'previous executable was not restored')
}

New-Fixture
$script:SignatureStatus = 'Invalid'
$message = Invoke-Main -AllowUnsigned
if ($message -and $message -like '*signature verification failed*') {
  Pass 'reports invalid signature separately from unsigned policy'
} else {
  FailTest 'reports invalid signature separately from unsigned policy' ($message -or 'unexpected signature result')
}

New-Fixture
Set-Content -LiteralPath (Join-Path $script:Fixture 'manifest') -Value ('0' * 64 + '  ../unsafe')
Expect-Failure 'rejects malicious checksum filenames' 'unsafe or malformed' { Invoke-Main -AllowUnsigned }
New-Fixture
Set-Content -LiteralPath (Join-Path $script:Fixture 'manifest') -Value ('0' * 64 + '  tailscale-browser-ext-windows-amd64.exe' + [Environment]::NewLine + '1' * 64 + '  tailscale-browser-ext-windows-amd64.exe')
Expect-Failure 'rejects duplicate checksum entries' 'exactly one checksum' { Invoke-Main -AllowUnsigned }

New-Fixture
$targetDirectory = Join-Path $env:LOCALAPPDATA 'Tailchrome'
New-Item -ItemType Directory -Path $targetDirectory -Force | Out-Null
$lockPath = Join-Path $targetDirectory '.tailchrome-install.lock'
$lock = [IO.File]::Open($lockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
try {
  Expect-Failure 'rejects a concurrent Windows install' 'Another Tailchrome installation' { Invoke-Main -AllowUnsigned }
} finally { $lock.Dispose() }

New-Fixture
$script:TestArch = 'arm64'
Set-Manifest
$script:RegisterFail = $true
$message = Invoke-Main -AllowUnsigned
if ($message -and $script:LastDownload -like '*tailscale-browser-ext-windows-arm64.exe') {
  Pass 'selects the requested native ARM64 asset'
} else {
  FailTest 'selects the requested native ARM64 asset' ($message -or 'ARM64 asset was not selected')
}

if ($WindowsTest) {
  $nativeArchitecture = & $ProductionGetNativeArchitecture
  $expectedArchitecture = $env:TAILCHROME_EXPECTED_NATIVE_ARCHITECTURE
  if (-not $expectedArchitecture) {
    FailTest 'detects native OS architecture, including an emulated ARM64 shell' 'TAILCHROME_EXPECTED_NATIVE_ARCHITECTURE was not set by the Windows CI job'
  } elseif ($nativeArchitecture -eq $expectedArchitecture.ToLowerInvariant()) {
    Pass 'detects native OS architecture from the explicit Windows CI expectation'
  } else {
    FailTest 'detects native OS architecture from the explicit Windows CI expectation' ("expected [$expectedArchitecture], got [$nativeArchitecture]")
  }
  # Native Windows-only race fixture. Compile a real .NET Framework EXE, run it
  # from the destination itself, and keep its image mapped until the assertion.
  New-Fixture
  $source = Join-Path $script:Fixture 'LockFile.cs'
  $locker = Join-Path $script:Fixture 'LockFile.exe'
@'
using System;
class LockFile {
  static void Main(string[] args) {
    Console.WriteLine("ready");
    Console.Out.Flush();
    Console.ReadLine();
  }
}
'@ | Set-Content -LiteralPath $source
  $cscCandidates = @(@(
    (Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'),
    (Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe')
  ) | Where-Object { Test-Path -LiteralPath $_ })
  if ($cscCandidates.Count -eq 0) {
    FailTest 'rejects a native mapped destination' 'stock .NET Framework csc.exe was not found'
    $locker = $null
  } else {
    & $cscCandidates[0] /nologo /target:exe /out:$locker $source *> $null
    if ($LASTEXITCODE -ne 0) {
      FailTest 'rejects a native mapped destination' 'stock .NET Framework csc.exe failed to compile the fixture'
      $locker = $null
    }
  }
  if ($locker) {
    $destination = Join-Path $env:LOCALAPPDATA 'Tailchrome/tailchrome.exe'
    New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
    Copy-Item -LiteralPath $locker -Destination $destination
    $processInfo = New-Object System.Diagnostics.ProcessStartInfo
    $processInfo.FileName = $destination
    $processInfo.UseShellExecute = $false
    $processInfo.RedirectStandardInput = $true
    $processInfo.RedirectStandardOutput = $true
    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $processInfo
    $null = $process.Start()
    $readyTask = $process.StandardOutput.ReadLineAsync()
    $readyWithinTimeout = $false
    try {
      $readyWithinTimeout = $readyTask.Wait(5000)
      if (-not $readyWithinTimeout) {
        FailTest 'rejects a native mapped destination' 'mapped fixture did not report ready within 5000ms'
      } elseif ($readyTask.Result -ne 'ready') {
        FailTest 'rejects a native mapped destination' 'mapped fixture did not report ready'
      } else {
        Expect-Failure 'rejects a native mapped destination' 'in use or mapped' { Invoke-Main -AllowUnsigned }
      }
    } finally {
      $cleanupFailures = New-Object 'System.Collections.Generic.List[string]'
      try {
        if ($readyWithinTimeout) {
          try {
            $process.StandardInput.Close()
          } catch {
            [void]$cleanupFailures.Add("could not close fixture stdin: $($_.Exception.Message)")
          }
          try {
            if (-not $process.WaitForExit(3000)) {
              [void]$cleanupFailures.Add('fixture process did not exit within 3 seconds after graceful close')
            }
          } catch {
            [void]$cleanupFailures.Add("graceful fixture wait failed: $($_.Exception.Message)")
          }
        }
        $fixtureStillRunning = $true
        try {
          $fixtureStillRunning = -not $process.HasExited
        } catch {
          [void]$cleanupFailures.Add("could not determine fixture process state: $($_.Exception.Message)")
        }
        if ($fixtureStillRunning) {
          try {
            $process.Kill()
          } catch {
            try {
              if (-not $process.HasExited) {
                [void]$cleanupFailures.Add("could not terminate fixture: $($_.Exception.Message)")
              }
            } catch {
              [void]$cleanupFailures.Add("could not determine whether fixture termination succeeded: $($_.Exception.Message)")
            }
          }
          try {
            if (-not $process.WaitForExit(3000)) {
              [void]$cleanupFailures.Add('fixture process did not exit within 3 seconds after Kill()')
            }
          } catch {
            [void]$cleanupFailures.Add("post-Kill fixture wait failed: $($_.Exception.Message)")
          }
        }
      } catch {
        [void]$cleanupFailures.Add("fixture cleanup failed: $($_.Exception.Message)")
      } finally {
        try {
          $process.Dispose()
        } catch {
          [void]$cleanupFailures.Add("could not dispose fixture process: $($_.Exception.Message)")
        }
      }
      if ($cleanupFailures.Count -gt 0) {
        FailTest 'cleans up the native mapped destination fixture' ($cleanupFailures -join '; ')
      }
    }
  }
} else {
  Pass 'native mapped destination race (skipped off Windows)'
}

if ($script:Fixture) { Remove-Item -LiteralPath $script:Fixture -Recurse -Force -ErrorAction SilentlyContinue }
if ($script:TestsFailed -gt 0) { throw "$script:TestsFailed of $script:TestsRun PowerShell tests failed" }
Write-Output "$script:TestsRun PowerShell tests passed"
