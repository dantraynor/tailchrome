# Security Policy

## Supported Versions

Only the latest release is supported with security updates.

## Reporting a Vulnerability

Please report security vulnerabilities by emailing admin@tesseras.org.

Do **not** open a public issue for security vulnerabilities.

We will acknowledge your report within 48 hours and aim to release a fix for critical issues within 7 days.

## Verifying Release Artifacts

Download artifacts only from this repository's GitHub Releases page. Verify the release checksum manifest before running an installer or helper:

```bash
sha256sum --check SHA256SUMS.txt
```

On macOS, verify the Developer ID and notarization assessment:

```bash
pkgutil --check-signature tailchrome-helper-macos.pkg
xcrun stapler validate tailchrome-helper-macos.pkg
spctl --assess --type install --verbose=2 tailchrome-helper-macos.pkg
```

On Windows, inspect both the raw helper and MSI:

```powershell
Get-AuthenticodeSignature .\tailscale-browser-ext-windows-amd64.exe |
  Format-List Status,SignerCertificate,TimeStamperCertificate
Get-AuthenticodeSignature .\tailchrome-helper-windows-x64.msi |
  Format-List Status,SignerCertificate,TimeStamperCertificate
```

Both Windows files must report `Valid`, contain a timestamp certificate, and use the exact publisher subject recorded in the Windows code-signing policy. The MSI contains the same signed helper released as the raw EXE; publication verifies the embedded file's SHA-256 against the raw file.

Where GitHub artifact attestations are available, verify them against this repository:

```bash
gh attestation verify <artifact> --repo dantraynor/tailchrome
```

## Scanner Detections and SmartScreen

An actual Defender or Malwarebytes malware, potentially unwanted application, or behavioral detection blocks release. Report a suspected false positive with the exact file hash and detection details through the [Microsoft Security Intelligence submission portal](https://www.microsoft.com/en-us/wdsi/filesubmission) or [Malwarebytes false-positive process](https://help.malwarebytes.com/hc/en-us/articles/31589211404571-Report-a-false-positive-to-Malwarebytes-Support). Do not publish the affected candidate while a vendor determination is pending.

A validly signed application can still show a normal Microsoft Defender SmartScreen “unrecognized app” prompt while the publisher or file builds reputation. That prompt alone is not a malware determination. Confirm the signature first; report a malicious or PUA classification, invalid signature, or other concrete detection separately.

## Local Helper Diagnostics

Helper diagnostic reports are generated only when the user clicks the copy or export action. They remain local until the user chooses to share them. Reports use an explicit allowlist, bound and sanitize native error text, and exclude browsing data, URLs, authentication data, tailnet and peer identity, profile identity, traffic data, credentials, and persistent tracking identifiers.

## Local Proxy Trust Boundary

The helper exposes its SOCKS5/HTTP proxy only on a randomly assigned `127.0.0.1` port. Browser proxy APIs do not support attaching authentication credentials to PAC/listener-selected SOCKS connections, so the listener itself is unauthenticated.

On a normal single-user workstation, the loopback binding prevents remote access and the random port limits accidental discovery. On a shared machine, another process running as any local user may be able to discover the listening port and use the browser profile's tailnet access. Tailchrome should therefore be installed only on machines where local users and processes are trusted; use separate OS accounts or a dedicated machine for mutually untrusted users.
