param(
  [string]$SignToolPath = $env:WINDOWS_SIGNTOOL_PATH
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$Verifier = Join-Path $PSScriptRoot "verify-windows-signatures.ps1"
$BuildMsi = Join-Path $PSScriptRoot "..\packaging\windows\build-msi.ps1"
$SignTool = (Resolve-Path -LiteralPath $SignToolPath -ErrorAction Stop).Path
$WixCommand = Get-Command wix -ErrorAction SilentlyContinue
if ($null -eq $WixCommand) {
  throw "WiX 6 is required. Install it with: dotnet tool install --global wix --version 6.0.2"
}

$TestRoot = Join-Path ([System.IO.Path]::GetTempPath()) "tailchrome-signature-tests-$([Guid]::NewGuid().ToString('N'))"
$PasswordText = "tailchrome-test-$([Guid]::NewGuid().ToString('N'))"
$Password = ConvertTo-SecureString -String $PasswordText -AsPlainText -Force
$TestSubject = "CN=Tailchrome Signature Verifier Test"
$Certificates = [System.Collections.Generic.List[System.Security.Cryptography.X509Certificates.X509Certificate2]]::new()

function Invoke-NativeCommand {
  param(
    [Parameter(Mandatory = $true)]
    [scriptblock]$Command,

    [Parameter(Mandatory = $true)]
    [string]$FailureMessage
  )

  $Output = @(& $Command 2>&1)
  if ($LASTEXITCODE -ne 0) {
    throw "$FailureMessage`: $($Output -join [Environment]::NewLine)"
  }
  return $Output
}

function New-TestCertificate {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Subject,

    [Parameter(Mandatory = $true)]
    [string]$Name
  )

  $Certificate = New-SelfSignedCertificate `
    -Type Custom `
    -Subject $Subject `
    -FriendlyName $Name `
    -CertStoreLocation "Cert:\CurrentUser\My" `
    -KeyAlgorithm RSA `
    -KeyLength 2048 `
    -KeyExportPolicy Exportable `
    -HashAlgorithm SHA256 `
    -KeyUsage DigitalSignature `
    -NotAfter (Get-Date).AddDays(2) `
    -TextExtension @("2.5.29.37={text}1.3.6.1.5.5.7.3.3")
  $Certificates.Add($Certificate)

  $CerPath = Join-Path $TestRoot "$Name.cer"
  Export-Certificate -Cert $Certificate -FilePath $CerPath | Out-Null
  $PublicCertificate = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new($CerPath)
  try {
    foreach ($StoreName in @("Root", "TrustedPublisher")) {
      Write-Host "Trusting test certificate in CurrentUser\$StoreName..."
      $Store = [System.Security.Cryptography.X509Certificates.X509Store]::new(
        $StoreName,
        [System.Security.Cryptography.X509Certificates.StoreLocation]::CurrentUser
      )
      try {
        $Store.Open([System.Security.Cryptography.X509Certificates.OpenFlags]::ReadWrite)
        $Store.Add($PublicCertificate)
      } finally {
        $Store.Dispose()
      }

      $CertificatePath = "Cert:\CurrentUser\$StoreName\$($Certificate.Thumbprint)"
      if (-not (Test-Path -LiteralPath $CertificatePath)) {
        throw "The test certificate was not installed in CurrentUser\$StoreName."
      }
    }
  } finally {
    $PublicCertificate.Dispose()
  }

  $PfxPath = Join-Path $TestRoot "$Name.pfx"
  Export-PfxCertificate -Cert $Certificate -FilePath $PfxPath -Password $Password | Out-Null

  return [ordered]@{
    Certificate = $Certificate
    PfxPath = $PfxPath
  }
}

function Invoke-Sign {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path,

    [Parameter(Mandatory = $true)]
    [string]$PfxPath,

    [switch]$Append,
    [switch]$WithoutTimestamp
  )

  $TimestampMode = if ($WithoutTimestamp) { "without timestamp" } else { "with timestamp" }
  Write-Host "Signing fixture $(Split-Path -Leaf $Path) $TimestampMode..."

  $Arguments = @("sign", "/fd", "SHA256")
  if ($Append) {
    $Arguments += "/as"
  }
  if (-not $WithoutTimestamp) {
    $Arguments += @("/tr", "http://timestamp.digicert.com", "/td", "SHA256")
  }
  $Arguments += @("/f", $PfxPath, "/p", $PasswordText, $Path)

  $Attempts = if ($WithoutTimestamp) { 1 } else { 3 }
  for ($Attempt = 1; $Attempt -le $Attempts; $Attempt++) {
    $Output = @(& $SignTool @Arguments 2>&1)
    if ($LASTEXITCODE -eq 0) {
      return
    }
    if ($Attempt -eq $Attempts) {
      throw "SignTool could not sign '$Path': $($Output -join [Environment]::NewLine)"
    }
    Start-Sleep -Seconds 2
  }
}

function Assert-Throws {
  param(
    [Parameter(Mandatory = $true)]
    [scriptblock]$Operation,

    [Parameter(Mandatory = $true)]
    [string]$MessagePattern
  )

  try {
    & $Operation
  } catch {
    if ($_.Exception.Message -notmatch $MessagePattern) {
      throw "Expected failure matching '$MessagePattern'; got: $($_.Exception.Message)"
    }
    return
  }
  throw "Expected operation to fail with '$MessagePattern'."
}

New-Item -ItemType Directory -Force -Path $TestRoot | Out-Null

try {
  $Primary = New-TestCertificate -Subject $TestSubject -Name "primary"

  $UnsignedExe = Join-Path $TestRoot "unsigned.exe"
  Add-Type `
    -TypeDefinition 'public static class Program { public static int Main() { return 0; } }' `
    -Language CSharp `
    -OutputAssembly $UnsignedExe `
    -OutputType ConsoleApplication

  Assert-Throws -MessagePattern "Release-quality MSI builds require -ExpectedSignerSubject" -Operation {
    & $BuildMsi `
      -Version "v0.0.0" `
      -HelperExe $UnsignedExe `
      -OutPath (Join-Path $TestRoot "rejected-unsigned.msi")
  }
  & $BuildMsi `
    -Version "v0.0.0" `
    -HelperExe $UnsignedExe `
    -OutPath (Join-Path $TestRoot "development-unsigned.msi") `
    -AllowUnsignedDevelopmentBuild

  $SignedExe = Join-Path $TestRoot "tailscale-browser-ext-windows-amd64.exe"
  Copy-Item -LiteralPath $UnsignedExe -Destination $SignedExe
  Invoke-Sign -Path $SignedExe -PfxPath $Primary.PfxPath

  $UnsignedMsi = Join-Path $TestRoot "tailchrome-helper-windows-x64.unsigned.msi"
  & $BuildMsi `
    -Version "v0.0.0" `
    -HelperExe $SignedExe `
    -OutPath $UnsignedMsi `
    -ExpectedSignerSubject $TestSubject `
    -SignToolPath $SignTool

  $SignedMsi = Join-Path $TestRoot "tailchrome-helper-windows-x64.msi"
  Copy-Item -LiteralPath $UnsignedMsi -Destination $SignedMsi
  Invoke-Sign -Path $SignedMsi -PfxPath $Primary.PfxPath

  $SummaryPath = Join-Path $TestRoot "signature-summary.json"
  & $Verifier `
    -RawExe $SignedExe `
    -Msi $SignedMsi `
    -ExpectedSignerSubject $TestSubject `
    -SignToolPath $SignTool `
    -SummaryPath $SummaryPath | Out-Null
  $Summary = Get-Content -LiteralPath $SummaryPath -Raw | ConvertFrom-Json
  if (-not $Summary.embeddedMatchesRaw -or $Summary.expectedSignerSubject -cne $TestSubject) {
    throw "Positive signature fixture returned an invalid summary."
  }

  Assert-Throws -MessagePattern "Raw EXE Authenticode signature is not valid" -Operation {
    & $Verifier -RawExe $UnsignedExe -Msi $SignedMsi -ExpectedSignerSubject $TestSubject -SignToolPath $SignTool
  }
  Assert-Throws -MessagePattern "MSI Authenticode signature is not valid" -Operation {
    & $Verifier -RawExe $SignedExe -Msi $UnsignedMsi -ExpectedSignerSubject $TestSubject -SignToolPath $SignTool
  }

  $UntimestampedExe = Join-Path $TestRoot "untimestamped.exe"
  Copy-Item -LiteralPath $UnsignedExe -Destination $UntimestampedExe
  Invoke-Sign -Path $UntimestampedExe -PfxPath $Primary.PfxPath -WithoutTimestamp
  Assert-Throws -MessagePattern "not timestamped" -Operation {
    & $Verifier -RawExe $UntimestampedExe -Msi $SignedMsi -ExpectedSignerSubject $TestSubject -SignToolPath $SignTool
  }

  Assert-Throws -MessagePattern "signer subject mismatch" -Operation {
    & $Verifier -RawExe $SignedExe -Msi $SignedMsi -ExpectedSignerSubject "CN=Unexpected Publisher" -SignToolPath $SignTool
  }

  $TamperedExe = Join-Path $TestRoot "tampered.exe"
  Copy-Item -LiteralPath $SignedExe -Destination $TamperedExe
  $TamperedBytes = [System.IO.File]::ReadAllBytes($TamperedExe)
  $TamperOffset = [Math]::Min(512, $TamperedBytes.Length - 1)
  $TamperedBytes[$TamperOffset] = $TamperedBytes[$TamperOffset] -bxor 0x01
  [System.IO.File]::WriteAllBytes($TamperedExe, $TamperedBytes)
  Assert-Throws -MessagePattern "Raw EXE Authenticode signature is not valid" -Operation {
    & $Verifier -RawExe $TamperedExe -Msi $SignedMsi -ExpectedSignerSubject $TestSubject -SignToolPath $SignTool
  }

  $MultiSignedExe = Join-Path $TestRoot "multi-signed.exe"
  Copy-Item -LiteralPath $SignedExe -Destination $MultiSignedExe
  Invoke-Sign -Path $MultiSignedExe -PfxPath $Primary.PfxPath -Append
  Assert-Throws -MessagePattern "multiple Authenticode signatures" -Operation {
    & $Verifier -RawExe $MultiSignedExe -Msi $SignedMsi -ExpectedSignerSubject $TestSubject -SignToolPath $SignTool
  }
  Assert-Throws -MessagePattern "multiple Authenticode signatures" -Operation {
    & $BuildMsi `
      -Version "v0.0.0" `
      -HelperExe $MultiSignedExe `
      -OutPath (Join-Path $TestRoot "rejected-multi-signed.msi") `
      -ExpectedSignerSubject $TestSubject `
      -SignToolPath $SignTool
  }

  $OtherExe = Join-Path $TestRoot "other.exe"
  Add-Type `
    -TypeDefinition 'public static class OtherProgram { public static int Main() { return 1; } }' `
    -Language CSharp `
    -OutputAssembly $OtherExe `
    -OutputType ConsoleApplication
  Invoke-Sign -Path $OtherExe -PfxPath $Primary.PfxPath
  $MismatchUnsignedMsi = Join-Path $TestRoot "mismatch.unsigned.msi"
  & $BuildMsi `
    -Version "v0.0.0" `
    -HelperExe $OtherExe `
    -OutPath $MismatchUnsignedMsi `
    -ExpectedSignerSubject $TestSubject `
    -SignToolPath $SignTool
  $MismatchMsi = Join-Path $TestRoot "mismatch.msi"
  Copy-Item -LiteralPath $MismatchUnsignedMsi -Destination $MismatchMsi
  Invoke-Sign -Path $MismatchMsi -PfxPath $Primary.PfxPath
  Assert-Throws -MessagePattern "does not match the final raw EXE" -Operation {
    & $Verifier -RawExe $SignedExe -Msi $MismatchMsi -ExpectedSignerSubject $TestSubject -SignToolPath $SignTool
  }

  $EmptyWxs = Join-Path $TestRoot "empty.wxs"
  $NonHelperPayload = Join-Path $TestRoot "readme.txt"
  Set-Content -LiteralPath $NonHelperPayload -Encoding utf8NoBOM -Value "No helper payload"
  Set-Content -LiteralPath $EmptyWxs -Encoding utf8NoBOM -Value @'
<Wix xmlns="http://wixtoolset.org/schemas/v4/wxs">
  <Package Name="Empty Test Package" Manufacturer="Tesseras" Version="0.0.0" UpgradeCode="925835D6-D73E-48E6-8E3B-C5B04B14FE55">
    <MediaTemplate EmbedCab="yes" />
    <StandardDirectory Id="LocalAppDataFolder">
      <Directory Id="EmptyTestFolder" Name="TailchromeSignatureTest">
        <Component Id="NonHelperPayload" Guid="835C96A8-CF84-4854-B219-C61394423110">
          <File Id="ReadmeFile" Source="$(var.NonHelperPayload)" Name="readme.txt" KeyPath="yes" />
        </Component>
      </Directory>
    </StandardDirectory>
    <Feature Id="EmptyTestFeature" Title="Empty Test Feature" Level="1">
      <ComponentRef Id="NonHelperPayload" />
    </Feature>
  </Package>
</Wix>
'@
  $MissingExeMsi = Join-Path $TestRoot "missing-exe.msi"
  Invoke-NativeCommand `
    -Command { & $WixCommand.Source build -d "NonHelperPayload=$NonHelperPayload" $EmptyWxs -o $MissingExeMsi } `
    -FailureMessage "WiX could not build the missing-payload fixture" | Out-Null
  Invoke-Sign -Path $MissingExeMsi -PfxPath $Primary.PfxPath
  Assert-Throws -MessagePattern "does not contain tailscale-browser-ext.exe" -Operation {
    & $Verifier -RawExe $SignedExe -Msi $MissingExeMsi -ExpectedSignerSubject $TestSubject -SignToolPath $SignTool
  }

  Write-Host "Windows signature verifier tests passed."
} finally {
  foreach ($Certificate in $Certificates) {
    foreach ($StoreName in @("My", "Root", "TrustedPublisher")) {
      $Store = [System.Security.Cryptography.X509Certificates.X509Store]::new(
        $StoreName,
        [System.Security.Cryptography.X509Certificates.StoreLocation]::CurrentUser
      )
      try {
        $Store.Open([System.Security.Cryptography.X509Certificates.OpenFlags]::ReadWrite)
        $Store.Remove($Certificate)
      } finally {
        $Store.Dispose()
      }
    }
  }
  if (Test-Path -LiteralPath $TestRoot) {
    Remove-Item -LiteralPath $TestRoot -Recurse -Force
  }
}
