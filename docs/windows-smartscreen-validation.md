# Windows browser-download and SmartScreen validation

Exercise the download path separately from signature verification, antivirus
scans, and direct `msiexec` installation. Those checks do not establish what
SmartScreen shows when a user opens a downloaded MSI in Explorer. A valid
production signature identifies the publisher; it does not guarantee that a
new file or certificate already has SmartScreen reputation.

Use a licensed Windows 11 validation machine with active Defender, cloud
protection, and Malwarebytes. Use an interactive standard-user desktop, a
normal supported browser, and an NTFS download directory. Record any reuse of
a machine, account, browser profile, or previously executed artifact: cached
decisions can affect the result. Do not reset a retained validation machine or
erase scanner history to make an investigation appear to be a first run.

## Identify the bytes and download route

Record the release tag, source commit, candidate run/attempt (if applicable),
manifest digest, expected MSI SHA-256, and UTC test time. Take the expected hash
from the reviewed manifest before downloading.

1. In the Windows browser, open the pinned release page and click the
   `tailchrome-helper-windows-x64.msi` asset. Record the original URL, browser
   name/version, download result, and any browser warning. Keep authentication
   and temporary redirect URLs out of shared evidence.
2. Save the download to the standard user's Downloads folder. Do not transfer
   the MSI through a shared drive, download it with PowerShell/curl, or use a
   previously extracted build artifact for this test.
3. Before opening it, verify its hash and Internet-zone marker in PowerShell
   under the same user. Replace the expected hash and select the actual
   downloaded filename, including any browser-added suffix:

   ```powershell
   $msi = Join-Path $env:USERPROFILE 'Downloads\tailchrome-helper-windows-x64.msi'
   $expectedSha256 = '<SHA-256 from the reviewed manifest>'
   $hash = (Get-FileHash -LiteralPath $msi -Algorithm SHA256).Hash.ToLowerInvariant()
   if ($hash -ne $expectedSha256.ToLowerInvariant()) { throw 'MSI hash mismatch.' }
   $zone = @(Get-Content -LiteralPath $msi -Stream Zone.Identifier -ErrorAction Stop)
   if (-not ($zone -match '^ZoneId=3\s*$')) { throw 'Internet-zone marker is missing.' }
   [pscustomobject]@{ file = Split-Path -Leaf $msi; sha256 = $hash; zoneId = 3 }
   $signature = Get-AuthenticodeSignature -LiteralPath $msi
   $signature | Select-Object Status, StatusMessage
   $signature.SignerCertificate | Select-Object Subject, Issuer, Thumbprint, NotBefore, NotAfter
   $signature.TimeStamperCertificate | Select-Object Subject, Issuer, Thumbprint
   ```

   Keep the original `Zone.Identifier` stream intact. The report only needs
   `ZoneId`, not the potentially sensitive redirect URLs in the other fields.
   If the browser blocks the download or the marker is absent, preserve that
   result; do not manufacture the marker or disable a protection to proceed.

For an unpublished candidate, use its approved draft download or a documented
HTTPS staging URL for the exact final MSI. Record that origin accurately;
staging does not establish the reputation of the eventual public URL. Repeat
the test from the public release page after publication. Never change a
published asset to investigate a warning. The v0.1.15 MSI remains unsigned;
test any future signed candidate separately, with its own hash and evidence.

## Record Windows and protection state

Capture the Windows edition/build, browser version, whether the account is a
standard user or administrator, and whether the launch is elevated. An
unelevated administrator is not a standard-user test. Record whether the
machine is organization-managed or enrolled in MDM. Keep account names and
tenant/device identifiers private unless needed for the investigation.

These read-only queries provide the OS and Defender versions:

```powershell
Get-CimInstance Win32_OperatingSystem | Select-Object Caption, Version, BuildNumber, OSArchitecture
Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion' |
  Select-Object DisplayVersion, CurrentBuild, UBR
Get-MpComputerStatus | Select-Object AMRunningMode, AMProductVersion,
  AntivirusSignatureVersion, AntivirusSignatureLastUpdated, AntivirusEnabled,
  RealTimeProtectionEnabled, BehaviorMonitorEnabled, IoavProtectionEnabled
Get-MpPreference | Select-Object MAPSReporting, DisableBlockAtFirstSeen, PUAProtection
```

Record Malwarebytes' version, definitions, and active protection status as
well. Check **Windows Security → App & browser control → Reputation-based
protection settings**, including **Check apps and files**. Record Smart App
Control if present. Collect effective Group Policy/MDM settings and the
following relevant registry values without changing them:

| Registry location | Values |
| --- | --- |
| `HKLM\SOFTWARE\Policies\Microsoft\Windows\System` | `EnableSmartScreen`, `ShellSmartScreenLevel` |
| `HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Explorer` | `SmartScreenEnabled` |
| `HKLM\SOFTWARE\Microsoft\PolicyManager\current\device\SmartScreen` | `EnableSmartScreenInShell`, `PreventOverrideForFilesInShell` |
| `HKLM\SOFTWARE\Policies\Microsoft\Edge` (if using Edge) | `SmartScreenEnabled`, `PreventSmartScreenPromptOverride`, `PreventSmartScreenPromptOverrideForFiles` |
| `HKLM` and `HKCU\SOFTWARE\Policies\Google\Chrome` (if using Chrome) | `SafeBrowsingProtectionLevel`, `DownloadRestrictions` |

Record missing values and permission errors explicitly. Registry absence alone
does not prove that a machine is unmanaged or establish its effective policy.
If an administrator collects additional machine-level evidence, label that
separate context and keep the Explorer launch in the original user session.

## Launch from Explorer

1. Open Downloads in Explorer and double-click the verified MSI. Do not use
   `msiexec`, an elevated shell, `Unblock-File`, Properties → Unblock, or a
   policy/antivirus exclusion as a substitute.
2. Capture the initial dialog. If **More info** is available, open it and
   capture the expanded dialog before choosing anything else. Record the
   exact message, filename, displayed publisher, and every available button,
   including whether **Run anyway** exists.
3. Record whether the installer opens without a prompt, after an available
   normal reputation override, or cannot open. Use an override only for the
   already hash-verified and scan-cleared validation artifact, with its
   expected signing status. Never override a malware/PUA detection or an
   invalid signature. Do not weaken policy to create a missing button.
4. If the installer opens, capture that window before continuing the normal
   lifecycle checklist. Otherwise preserve the block as the launch result.
   Inspect Windows Security Protection history and Malwarebytes reports for
   events matching the file and test time. Preserve any detection name and
   affected path separately from the reputation dialog.
5. Recheck the file hash and `ZoneId=3` after the observation. Store the
   screenshots and results with the exact candidate's security evidence.

## Interpret the observation

| Observation | Record |
| --- | --- |
| Installer opens without a warning | No prompt observed on this machine, account, browser, and date; not a universal reputation guarantee |
| Unrecognized app with a valid expected production publisher | Signed unknown-reputation prompt, separately from malware/PUA results |
| Unknown publisher on the intentionally unsigned v0.1.15 MSI | Expected absent signature; not proof of a malware detection |
| No override button | Installation blocked on this path; policy is one possible cause, and needs separate evidence |
| Named malware/PUA or behavioral detection, or invalid signature | Stop release clearance and follow the security investigation procedure |

A missing screenshot, untested route, missing Internet-zone marker, or policy
block is not a successful Explorer launch. Keep those limitations visible in
the evidence and the [release checklist](RELEASE_CHECKLIST.md).

References:

- [Microsoft Defender SmartScreen settings](https://learn.microsoft.com/en-us/windows/security/operating-system-security/virus-and-threat-protection/microsoft-defender-smartscreen/available-settings)
- [MDM PreventOverrideForFilesInShell policy](https://learn.microsoft.com/en-us/windows/client-management/mdm/policy-csp-smartscreen#preventoverrideforfilesinshell)
- [SmartScreen reputation](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation)
