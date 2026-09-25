# Windows Helper installer (.msi)

`build-msi.ps1` produces `dist/tailchrome-helper-windows-x64.msi`.

The x64 MSI is per-user. Starting in v0.1.14, it owns and registers this
executable directly:

```text
%LOCALAPPDATA%\Tailscale\BrowserExt\installer\tailscale-browser-ext.exe
```

After installation, the MSI invokes `install --binary-path` for its payload,
writing current-user manifests and HKCU native messaging registrations. It
makes no separate runtime copy. Uninstall invokes the ownership-aware
`uninstall --binary-path` before Windows Installer removes its files. Major
upgrades skip deregistration and replace the package payload.

The PowerShell bootstrap supports native amd64 and ARM64 Windows. Download
`tailchrome-install.ps1` from the chosen release and run:

```powershell
& .\tailchrome-install.ps1 -Version v0.1.14
```

It installs `%LOCALAPPDATA%\Tailchrome\tailchrome.exe`, verifies checksums and
available attestation, and requires a valid Authenticode signature. Explicitly
unsigned releases require `-AllowUnsigned`; invalid signatures still fail.
Close browsers before upgrading. The script refuses a mapped executable and
preserves the previous helper if replacement or registration fails. See
[helper installation](../../docs/helper-installation.md).

## Build

Install WiX first:

```powershell
dotnet tool install --global wix --version 6.0.2
```

Then build from the repository root:

```powershell
.\packaging\windows\build-msi.ps1 `
  -Version v0.1.14 `
  -AllowUnsignedDevelopmentBuild
```

The switch is deliberately explicit: its output is for local testing and is
not eligible for release.

## Release signing

Signed releases follow
[WINDOWS_CODE_SIGNING_POLICY.md](../../docs/WINDOWS_CODE_SIGNING_POLICY.md),
including its configured provider and exact publisher subject. The policy
also permits a separately selected unsigned release mode; failed signing never
silently selects that mode.

Both modes require clean Defender evidence for the exact final EXEs and MSI.
`-AllowUnsigned` does not bypass Windows Security detections; see
[blocked helper troubleshooting](../../docs/helper-installation.md#windows-security-blocks-the-helper).

The release order is:

1. Sign and timestamp both `tailscale-browser-ext-windows-amd64.exe` and `tailscale-browser-ext-windows-arm64.exe`.
2. Verify their Authenticode chains, SHA-256 digests, timestamps, and exact subjects.
3. Build the unsigned outer MSI from that exact signed EXE:

   ```powershell
   .\packaging\windows\build-msi.ps1 `
     -Version $env:RELEASE_TAG `
     -HelperExe .\signed-windows\tailscale-browser-ext-windows-amd64.exe `
     -OutPath .\signed-windows\tailchrome-helper-windows-x64.unsigned.msi `
     -ExpectedSignerSubject $env:WINDOWS_EXPECTED_SIGNER_SUBJECT `
     -SignToolPath $env:WINDOWS_SIGNTOOL_PATH
   ```

4. Sign and timestamp the outer MSI with the same publisher.
5. Verify both final raw EXEs, the amd64 MSI-embedded EXE, and the outer MSI:

   ```powershell
   .\scripts\verify-windows-signatures.ps1 `
     -RawExe .\signed-windows\tailscale-browser-ext-windows-amd64.exe `
     -RawArm64Exe .\signed-windows\tailscale-browser-ext-windows-arm64.exe `
     -Msi .\signed-windows\tailchrome-helper-windows-x64.msi `
     -ExpectedSignerSubject $env:WINDOWS_EXPECTED_SIGNER_SUBJECT `
     -SignToolPath $env:WINDOWS_SIGNTOOL_PATH `
     -SummaryPath .\signed-windows\windows-signature-summary.json
   ```

The verifier requires a pinned Windows SDK SignTool, a valid timestamp on each
signature, one exact signer subject, and a byte-identical embedded/raw EXE. Its
credential-free fixture suite runs on Windows CI:

```powershell
pwsh -NoProfile -File .\scripts\verify-windows-signatures.test.ps1 `
  -SignToolPath $env:WINDOWS_SIGNTOOL_PATH
```

## Automated Defender gate

In signed mode, the release workflow scans both final raw EXEs and the MSI on a single-use x64
Windows runner with the `self-hosted`, `Windows`, `X64`, and run-specific
`tailchrome-defender-<run-id>` labels. The GitHub-hosted Windows images
evaluated for this release run Defender in passive mode and are not accepted as
scan evidence.

The runner must be registered only to this repository with `--ephemeral`, use
an elevated service account, and be provisioned from a current, known-clean
image with active Defender and cloud protection and no scan exclusions. The
image must set a host-owned `ACTIONS_RUNNER_HOOK_JOB_STARTED` hook that rejects
any repository, workflow, job, run ID, tag, or source SHA other than the
approved release assignment before repository code executes. It must also set
the machine-level `TAILCHROME_DEFENDER_IMAGE_ID` to the immutable image version;
the hook and workflow both compare that observed value with the approved
environment value. Keep the runner offline until that assignment is approved,
give it no signing credentials or internal-network access, forward its
diagnostic logs externally, and destroy the VM after the job.

Configure a protected `windows-defender-validation` environment with a required
reviewer, no administrator bypass, a selected-tag policy of `v*`, and a
`WINDOWS_DEFENDER_IMAGE_ID` variable containing the immutable image or snapshot
version. Do not define that variable at repository or organization scope; the
preflight rejects broader-scope fallbacks. Provision the ephemeral runner only
after the environment approval, using the queued run ID in its custom label.
Qualify the clean image with:

```powershell
.\scripts\initialize-windows-defender.ps1 -RunDetectionSmokeTest
```

If that runner is unavailable or cannot prove every required protection, scan,
exclusion, detection, and hash check, candidate assembly remains blocked.
Failures inside the guarded scan phase upload a `result: "blocked"` evidence
file with the expected candidate hashes, available Defender definition and
detection details, and the failing check; that evidence cannot enter a
successful release candidate. Runner assignment, checkout, or workspace
preparation failures stop before trustworthy scan evidence can be created.

Final EXE and MSI hashes are generated only after signing and must match the
Defender and Malwarebytes evidence approved for publication. A validly signed
SmartScreen unknown-reputation prompt is documented but is not treated as a
malware detection; an actual malware, PUA, or behavioral detection blocks the
release.

## Architecture

v0.1.14 adds a native ARM64 raw helper through the PowerShell bootstrap. The
x64 MSI remains available on ARM64 through emulation. Release candidate
assembly requires native ARM64 smoke evidence for the exact final binary;
cross-compilation does not satisfy that gate.

## Repair

To rerun registration with the installed signed MSI, use Windows Installer
repair from **Installed apps**, or run this from either Command Prompt or
PowerShell after downloading the MSI:

```text
powershell.exe -NoProfile -Command "msiexec.exe /fa (Join-Path ([Environment]::GetFolderPath('UserProfile')) 'Downloads\tailchrome-helper-windows-x64.msi')"
```

Repair reruns the embedded helper with `install --binary-path` for the current
user. Tailchrome does not infer a Chromium product from browser strings; the
helper's tested current-user registration table is authoritative.

## Verify a downloaded installer

After checking the release checksum and attestation, Windows users can inspect
the published signatures directly:

```powershell
Get-AuthenticodeSignature .\tailscale-browser-ext-windows-amd64.exe |
  Format-List Status,StatusMessage,SignerCertificate,TimeStamperCertificate
Get-AuthenticodeSignature .\tailchrome-helper-windows-x64.msi |
  Format-List Status,StatusMessage,SignerCertificate,TimeStamperCertificate
```

Both statuses must be `Valid`, both signer subjects must match the subject
listed in the release, and both timestamp certificates must be present.

## Uninstall

Remove **Tailchrome Helper** from **Installed apps**, or run:

```powershell
msiexec.exe /x .\tailchrome-helper-windows-x64.msi
```

The MSI removes its registrations before removing its package-owned payload.
For a script installation, use `& .\tailchrome-install.ps1 -Uninstall`.
Neither path deletes node identities. Older uninstallers do not understand
ownership receipts; remove them before switching methods or rerun the new
registration afterward.
