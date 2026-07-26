# Windows Helper installer (.msi)

`build-msi.ps1` produces `dist/tailchrome-helper-windows-x64.msi`.

The MSI is per-user. It installs a staged helper executable at:

```text
%LOCALAPPDATA%\Tailscale\BrowserExt\installer\tailscale-browser-ext.exe
```

After files are installed, the MSI runs that staged executable with `-install-now`. The Go installer then copies the browser-launched helper to `%LOCALAPPDATA%\Tailscale\BrowserExt\tailscale-browser-ext.exe` and writes HKCU native messaging registrations for supported Chromium-family browsers and Firefox.

On uninstall, the MSI runs the staged executable with `-uninstall` to remove those manifests, HKCU registrations, and normally the runtime executable. If a browser still has a runtime or moved-aside update executable open, the file may remain on disk but is inert once deregistered. Before uninstall, the new helper retries moved-aside sidecar cleanup on each launch after the old process exits; no administrator-only reboot cleanup is required. Major upgrades skip deregistration; the new version rewrites the registrations instead.

## Build

Install WiX first:

```powershell
dotnet tool install --global wix --version 6.0.2
```

Then build from the repository root:

```powershell
.\packaging\windows\build-msi.ps1 `
  -Version v0.1.12 `
  -AllowUnsignedDevelopmentBuild
```

The switch is deliberately explicit: its output is for local testing and is
not eligible for release.

## Release signing

Windows publication is disabled until
[WINDOWS_CODE_SIGNING_POLICY.md](../../docs/WINDOWS_CODE_SIGNING_POLICY.md)
records one accepted signing provider and the exact stable Authenticode signer
subject. A release cannot skip signing, fall back to a certificate file, or
switch provider through a workflow input.

The release order is:

1. Sign and timestamp `tailscale-browser-ext-windows-amd64.exe`.
2. Verify its Authenticode chain, SHA-256 digest, timestamp, and exact subject.
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
5. Verify the final raw EXE, the MSI-embedded EXE, and the outer MSI:

   ```powershell
   .\scripts\verify-windows-signatures.ps1 `
     -RawExe .\signed-windows\tailscale-browser-ext-windows-amd64.exe `
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

Final EXE and MSI hashes are generated only after signing and must match the
Defender and Malwarebytes evidence approved for publication. A validly signed
SmartScreen unknown-reputation prompt is documented but is not treated as a
malware detection; an actual malware, PUA, or behavioral detection blocks the
release.

## Architecture

The helper is currently published for amd64. The x64 MSI is the supported
Windows package on x64 and ARM64 Windows, where it runs under x64 emulation.

## Repair

To rerun registration with the installed signed MSI, use Windows Installer
repair from **Installed apps**, or run this from a PowerShell prompt with the
exact downloaded MSI path:

```powershell
msiexec.exe /fa .\tailchrome-helper-windows-x64.msi
```

Repair reruns the embedded signed helper with `-install-now` for the current
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

The MSI invokes the staged helper with `-uninstall`, removing the supported
HKCU native-messaging registrations and normally the runtime copy at:

```text
%LOCALAPPDATA%\Tailscale\BrowserExt\tailscale-browser-ext.exe
```
