param(
  [Parameter(Mandatory = $true)]
  [string]$RawExe,

  [Parameter(Mandatory = $true)]
  [string]$Msi,

  [Parameter(Mandatory = $true)]
  [string]$ExpectedSignerSubject,

  [string]$ExtractionDirectory = "",
  [string]$SignToolPath = $env:WINDOWS_SIGNTOOL_PATH,
  [string]$SummaryPath = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Security.Cryptography.Pkcs
if ($null -eq ("Tailchrome.AuthenticodeMessage" -as [type])) {
  Add-Type -Language CSharp -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

namespace Tailchrome
{
    public static class AuthenticodeMessage
    {
        private const uint CertQueryObjectFile = 1;
        private const uint CertQueryContentFlagPkcs7SignedEmbed = 0x00000400;
        private const uint CertQueryFormatFlagBinary = 0x00000002;
        private const uint CmsgEncodedMessage = 29;

        [DllImport("crypt32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool CryptQueryObject(
            uint objectType,
            string path,
            uint expectedContentTypeFlags,
            uint expectedFormatTypeFlags,
            uint flags,
            out uint encodingType,
            out uint contentType,
            out uint formatType,
            out IntPtr certificateStore,
            out IntPtr message,
            IntPtr context);

        [DllImport("crypt32.dll", SetLastError = true)]
        private static extern bool CryptMsgGetParam(
            IntPtr message,
            uint parameterType,
            uint index,
            IntPtr data,
            ref uint dataLength);

        [DllImport("crypt32.dll")]
        private static extern bool CryptMsgClose(IntPtr message);

        [DllImport("crypt32.dll")]
        private static extern bool CertCloseStore(IntPtr certificateStore, uint flags);

        public static byte[] ReadEmbeddedSignature(string path)
        {
            IntPtr certificateStore = IntPtr.Zero;
            IntPtr message = IntPtr.Zero;
            try
            {
                uint encodingType;
                uint contentType;
                uint formatType;
                if (!CryptQueryObject(
                    CertQueryObjectFile,
                    path,
                    CertQueryContentFlagPkcs7SignedEmbed,
                    CertQueryFormatFlagBinary,
                    0,
                    out encodingType,
                    out contentType,
                    out formatType,
                    out certificateStore,
                    out message,
                    IntPtr.Zero))
                {
                    throw new Win32Exception(
                        Marshal.GetLastWin32Error(),
                        "CryptQueryObject could not read the embedded Authenticode message.");
                }

                uint dataLength = 0;
                if (!CryptMsgGetParam(
                    message,
                    CmsgEncodedMessage,
                    0,
                    IntPtr.Zero,
                    ref dataLength))
                {
                    throw new Win32Exception(
                        Marshal.GetLastWin32Error(),
                        "CryptMsgGetParam could not size the Authenticode message.");
                }

                IntPtr data = Marshal.AllocHGlobal(checked((int)dataLength));
                try
                {
                    if (!CryptMsgGetParam(
                        message,
                        CmsgEncodedMessage,
                        0,
                        data,
                        ref dataLength))
                    {
                        throw new Win32Exception(
                            Marshal.GetLastWin32Error(),
                            "CryptMsgGetParam could not read the Authenticode message.");
                    }

                    byte[] encoded = new byte[checked((int)dataLength)];
                    Marshal.Copy(data, encoded, 0, checked((int)dataLength));
                    return encoded;
                }
                finally
                {
                    Marshal.FreeHGlobal(data);
                }
            }
            finally
            {
                if (message != IntPtr.Zero)
                {
                    CryptMsgClose(message);
                }
                if (certificateStore != IntPtr.Zero)
                {
                    CertCloseStore(certificateStore, 0);
                }
            }
        }
    }
}
'@
}

function Resolve-RequiredFile {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path,

    [Parameter(Mandatory = $true)]
    [string]$Label
  )

  if ([string]::IsNullOrWhiteSpace($Path)) {
    throw "$Label path is required."
  }

  $Resolved = Resolve-Path -LiteralPath $Path -ErrorAction Stop
  if (@($Resolved).Count -ne 1 -or -not (Test-Path -LiteralPath $Resolved.Path -PathType Leaf)) {
    throw "$Label must resolve to exactly one file: '$Path'."
  }

  return $Resolved.Path
}

function Invoke-SignToolVerification {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path,

    [Parameter(Mandatory = $true)]
    [string]$Label
  )

  $Output = @(& $script:ResolvedSignTool verify /pa /all /v $Path 2>&1)
  if ($LASTEXITCODE -ne 0) {
    throw "SignTool rejected $Label '$Path': $($Output -join [Environment]::NewLine)"
  }

  $SignatureIndexes = @($Output | Select-String -Pattern "^\s*Signature Index:\s*\d+\b")
  if ($SignatureIndexes.Count -gt 1) {
    throw "$Label contains multiple Authenticode signatures; the signer result is ambiguous."
  }
  if ($SignatureIndexes.Count -ne 1) {
    throw "SignTool could not prove that $Label has exactly one Authenticode signature."
  }

  $Sha256DigestLines = @($Output | Select-String -Pattern "(?i)Hash of file \(sha256\):")
  if ($Sha256DigestLines.Count -ne 1) {
    throw "$Label does not have exactly one SHA-256 Authenticode file digest."
  }
}

function Get-VerifiedSignature {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path,

    [Parameter(Mandatory = $true)]
    [string]$Label
  )

  $Signatures = @(Get-AuthenticodeSignature -LiteralPath $Path)
  if ($Signatures.Count -ne 1) {
    throw "Expected exactly one Authenticode result for $Label; found $($Signatures.Count)."
  }

  $Signature = $Signatures[0]
  if ($Signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid) {
    throw "$Label Authenticode signature is not valid: $($Signature.Status)."
  }
  if ($null -eq $Signature.SignerCertificate) {
    throw "$Label Authenticode signature does not contain a signer certificate."
  }

  $ActualSubject = $Signature.SignerCertificate.Subject
  if (-not [string]::Equals(
      $ActualSubject,
      $ExpectedSignerSubject,
      [System.StringComparison]::Ordinal
    )) {
    throw "$Label signer subject mismatch. Expected '$ExpectedSignerSubject'; found '$ActualSubject'."
  }
  if ($null -eq $Signature.TimeStamperCertificate) {
    throw "$Label Authenticode signature is not timestamped."
  }

  $EncodedMessage = [Tailchrome.AuthenticodeMessage]::ReadEmbeddedSignature($Path)
  $SignedCms = [System.Security.Cryptography.Pkcs.SignedCms]::new()
  $SignedCms.Decode($EncodedMessage)
  if ($SignedCms.SignerInfos.Count -ne 1) {
    throw "$Label does not contain exactly one PKCS #7 signer."
  }
  $SignerInfo = $SignedCms.SignerInfos[0]
  $Rfc3161Attributes = @(
    $SignerInfo.UnsignedAttributes |
      Where-Object { $_.Oid.Value -eq "1.3.6.1.4.1.311.3.3.1" }
  )
  if (
    $Rfc3161Attributes.Count -ne 1 -or
    $Rfc3161Attributes[0].Values.Count -ne 1
  ) {
    throw "$Label does not contain exactly one RFC 3161 timestamp."
  }
  if ($SignerInfo.CounterSignerInfos.Count -ne 0) {
    throw "$Label contains a legacy Authenticode countersignature; only RFC 3161 timestamps are accepted."
  }

  Invoke-SignToolVerification -Path $Path -Label $Label

  return [ordered]@{
    path = $Path
    sha256 = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
    signerSubject = $ActualSubject
    signerThumbprint = $Signature.SignerCertificate.Thumbprint
    timestampSubject = $Signature.TimeStamperCertificate.Subject
    timestampThumbprint = $Signature.TimeStamperCertificate.Thumbprint
    timestampType = "RFC3161"
    status = $Signature.Status.ToString()
  }
}

if ([string]::IsNullOrWhiteSpace($ExpectedSignerSubject)) {
  throw "-ExpectedSignerSubject must be the exact selected release publisher subject."
}

$RawExePath = Resolve-RequiredFile -Path $RawExe -Label "Raw EXE"
$MsiPath = Resolve-RequiredFile -Path $Msi -Label "MSI"
$script:ResolvedSignTool = Resolve-RequiredFile -Path $SignToolPath -Label "SignTool"

$WixCommand = Get-Command wix -ErrorAction SilentlyContinue
if ($null -eq $WixCommand) {
  throw "WiX 6 is required to extract the MSI without executing it."
}

$RemoveExtractionDirectory = $false
if ([string]::IsNullOrWhiteSpace($ExtractionDirectory)) {
  $ExtractionDirectory = Join-Path ([System.IO.Path]::GetTempPath()) "tailchrome-msi-$([Guid]::NewGuid().ToString('N'))"
  $RemoveExtractionDirectory = $true
} else {
  $ExtractionDirectory = [System.IO.Path]::GetFullPath($ExtractionDirectory)
  if (Test-Path -LiteralPath $ExtractionDirectory) {
    if (@(Get-ChildItem -LiteralPath $ExtractionDirectory -Force).Count -ne 0) {
      throw "Extraction directory must be empty: '$ExtractionDirectory'."
    }
  }
}

New-Item -ItemType Directory -Force -Path $ExtractionDirectory | Out-Null

try {
  $RawResult = Get-VerifiedSignature -Path $RawExePath -Label "Raw EXE"
  $MsiResult = Get-VerifiedSignature -Path $MsiPath -Label "MSI"

  $DecompiledPath = Join-Path $ExtractionDirectory "package.wxs"
  $WixOutput = @(
    & $WixCommand.Source msi decompile `
      -x $ExtractionDirectory `
      -o $DecompiledPath `
      $MsiPath 2>&1
  )
  if ($LASTEXITCODE -ne 0) {
    throw "WiX could not extract the MSI: $($WixOutput -join [Environment]::NewLine)"
  }

  [xml]$Decompiled = Get-Content -LiteralPath $DecompiledPath -Raw
  $NamespaceManager = [System.Xml.XmlNamespaceManager]::new($Decompiled.NameTable)
  $NamespaceManager.AddNamespace("wix", $Decompiled.DocumentElement.NamespaceURI)
  $EmbeddedFileNodes = @(
    $Decompiled.SelectNodes("//wix:File", $NamespaceManager) |
      Where-Object { $_.GetAttribute("Name") -ieq "tailscale-browser-ext.exe" }
  )
  if ($EmbeddedFileNodes.Count -eq 0) {
    throw "The MSI does not contain tailscale-browser-ext.exe."
  }
  if ($EmbeddedFileNodes.Count -ne 1) {
    throw "The MSI contains multiple tailscale-browser-ext.exe payloads; expected exactly one."
  }

  $EmbeddedFileNode = $EmbeddedFileNodes[0]
  $EmbeddedFileId = $EmbeddedFileNode.GetAttribute("Id")
  if (-not [string]::Equals(
      $EmbeddedFileId,
      "HelperExe",
      [System.StringComparison]::Ordinal
    )) {
    throw "The MSI helper payload does not use the expected HelperExe file identifier."
  }
  $EmbeddedPath = [System.IO.Path]::GetFullPath(
    (Join-Path (Join-Path $ExtractionDirectory "File") $EmbeddedFileId)
  )
  $ExtractionRoot = [System.IO.Path]::GetFullPath($ExtractionDirectory).TrimEnd(
    [System.IO.Path]::DirectorySeparatorChar,
    [System.IO.Path]::AltDirectorySeparatorChar
  ) + [System.IO.Path]::DirectorySeparatorChar
  if (-not $EmbeddedPath.StartsWith($ExtractionRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "The MSI helper payload resolved outside the extraction directory."
  }
  if (-not (Test-Path -LiteralPath $EmbeddedPath -PathType Leaf)) {
    throw "The MSI helper payload was not extracted from the cabinet."
  }

  $EmbeddedResult = Get-VerifiedSignature -Path $EmbeddedPath -Label "MSI-embedded EXE"
  if (-not [string]::Equals(
      $RawResult.sha256,
      $EmbeddedResult.sha256,
      [System.StringComparison]::Ordinal
    )) {
    throw "The MSI-embedded EXE SHA-256 does not match the final raw EXE."
  }

  $Summary = [ordered]@{
    schemaVersion = 1
    expectedSignerSubject = $ExpectedSignerSubject
    rawExe = $RawResult
    embeddedExe = $EmbeddedResult
    msi = $MsiResult
    embeddedMatchesRaw = $true
  }
  $SummaryJson = $Summary | ConvertTo-Json -Depth 5

  if (-not [string]::IsNullOrWhiteSpace($SummaryPath)) {
    $SummaryPath = [System.IO.Path]::GetFullPath($SummaryPath)
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $SummaryPath) | Out-Null
    Set-Content -LiteralPath $SummaryPath -Value $SummaryJson -Encoding utf8NoBOM
  }

  Write-Output $SummaryJson
} finally {
  if ($RemoveExtractionDirectory -and (Test-Path -LiteralPath $ExtractionDirectory)) {
    Remove-Item -LiteralPath $ExtractionDirectory -Recurse -Force
  }
}
