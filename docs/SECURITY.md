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

The helper exposes its SOCKS5/HTTP proxy on a randomly assigned `127.0.0.1` port and requires a fresh random credential on every helper launch. Credentials are sent over native messaging and held only by the background proxy manager, outside popup state, storage, and diagnostics. Chromium uses authenticated HTTP proxying; Firefox uses authenticated SOCKS5.

Update the extension and helper together. The extension blocks proxy use when a helper does not provide the authenticated proxy capability; current helpers do not expose an unauthenticated compatibility listener.

The helper checks destinations against its authoritative network map and current preferences. It permits Tailscale addresses, approved subnet routes, public destinations through a selected exit node, and attached private LAN destinations when LAN access is explicitly enabled. Loopback, link-local, and multicast destinations are blocked. The local Tailscale web client is authenticated separately before dispatch. DNS answers are checked before literal addresses are dialed; protected connections cannot fall back to the system network after route removal.

This limits access by other local users and processes that can discover the port. It does not protect against processes that can read the browser or helper memory or control the same operating-system account.
