# macOS helper installation

## Install for this user — no administrator access required

Download `tailchrome-helper-macos-user.zip` from the matching release, unzip it,
and open **Tailchrome Helper**. The signed, notarized app includes the universal
helper and installs it for your account. Keep the app to run setup again later.
It works on Apple Silicon and Intel Macs.

Your organization’s browser policy may still block extensions or native messaging.

## System package

Homebrew users can install the same signed release package with the
[Tailchrome cask](../homebrew/README.md#macos). It supports Apple Silicon and
Intel Macs and uses the package's existing registration and repair flow.
The [source formula](../homebrew/README.md#source-formula-macos-and-linux) is also
available for users who prefer to build the helper locally and register it
without administrator privileges.

The script `build-pkg.sh` builds both installers. The system package
`dist/tailchrome-helper-macos.pkg` requires administrator access and installs:

1. **Universal** `tailscale-browser-ext` at  
   `/Library/Application Support/Tailscale/BrowserExt/tailscale-browser-ext`
2. **Tailchrome Helper** in `/Applications` — a repair/re-run fallback app.

The package postinstall script runs `tailscale-browser-ext -install-now` for the logged-in console user, so normal installs do not require opening the app manually.

If browser discovery is later damaged, open
`/Applications/Tailchrome Helper.app`. The signed app launches the installed
system helper with `-install-now` and recreates the current user's supported
native-messaging registrations.

## Unsigned builds

CI and local runs without signing identities produce unsigned installers. Gatekeeper may require **right-click → Open** the first time, or **System Settings → Privacy & Security**.

## Signing and notarization (release quality)

Requirements: Apple Developer Program, **Developer ID Application** and **Developer ID Installer** certificates installed in the Keychain (or provided to CI via a `.p12` export — prefer a dedicated CI keychain on a runner you control).

1. Set identities (exact names from `security find-identity -p basic -v`):

   ```bash
   export MACOS_SIGN_APPLICATION_IDENTITY="Developer ID Application: Your Team (TEAMID)"
   export MACOS_SIGN_INSTALLER_IDENTITY="Developer ID Installer: Your Team (TEAMID)"
   ```

2. Build:

   ```bash
   ./packaging/macos/build-pkg.sh
   ```

3. Notarize both installers and staple their tickets:

   ```bash
   xcrun notarytool submit dist/tailchrome-helper-macos.pkg \
     --apple-id "$APPLE_ID" \
     --team-id "$APPLE_TEAM_ID" \
     --password "$APPLE_APP_SPECIFIC_PASSWORD" \
     --wait
   xcrun stapler staple dist/tailchrome-helper-macos.pkg
   xcrun notarytool submit dist/tailchrome-helper-macos-user.zip \
     --apple-id "$APPLE_ID" \
     --team-id "$APPLE_TEAM_ID" \
     --password "$APPLE_APP_SPECIFIC_PASSWORD" \
     --wait
   xcrun stapler staple "dist/Tailchrome Helper.app"
   rm dist/tailchrome-helper-macos-user.zip
   ditto -c -k --keepParent "dist/Tailchrome Helper.app" dist/tailchrome-helper-macos-user.zip
   ```

Store Apple credentials in GitHub Actions secrets for automated release; do not commit them.

Verify the final, stapled package and its repair app before candidate assembly:

```bash
pkgutil --check-signature dist/tailchrome-helper-macos.pkg
xcrun stapler validate dist/tailchrome-helper-macos.pkg
pkgutil --expand-full dist/tailchrome-helper-macos.pkg expanded-pkg
codesign --verify --deep --strict --verbose=2 \
  "expanded-pkg/Payload/Applications/Tailchrome Helper.app"
spctl --assess --type execute --verbose=2 \
  "expanded-pkg/Payload/Applications/Tailchrome Helper.app"
```

## GitHub Actions

Pull-request CI builds and inspects both installers and tests the per-user
launcher. Release CI signs and notarizes both, staples the package and app,
and includes the final archive in release checksums and provenance attestations.
Publication rechecks signatures and tickets without rebuilding.

## Per-user fallback

For terminal setup or repair, the release also contains a version-pinned
`tailchrome-install.sh` installer.
Replace `vX.Y.Z` below with the exact extension release, then download, verify,
inspect, and run the script:

```bash
VERSION=vX.Y.Z
BASE_URL="https://github.com/dantraynor/tailchrome/releases/download/$VERSION"
curl --fail --location --proto '=https' --tlsv1.2 \
  --output tailchrome-install.sh "$BASE_URL/tailchrome-install.sh"
curl --fail --location --proto '=https' --tlsv1.2 \
  --output SHA256SUMS.txt "$BASE_URL/SHA256SUMS.txt"
awk '$2 == "tailchrome-install.sh" { print }' SHA256SUMS.txt \
  > tailchrome-install.sh.sha256
test "$(wc -l < tailchrome-install.sh.sha256)" -eq 1
shasum -a 256 --check tailchrome-install.sh.sha256
gh attestation verify tailchrome-install.sh \
  --repo dantraynor/tailchrome
less tailchrome-install.sh
bash ./tailchrome-install.sh --version "$VERSION"
```

`gh attestation verify` is recommended when GitHub CLI is installed and
authenticated (`gh auth login`). Without it, the checksum still detects
corruption, but the script and checksum share the same GitHub Release trust
boundary.

The fallback installs the helper at:

```text
$HOME/Library/Application Support/Tailscale/BrowserExt/tailscale-browser-ext
```

It invokes the verified helper with `-install-now`; the helper remains the
authority for supported current-user browser registrations.

## Uninstall

For a package install, first remove the current user's native-messaging
registrations and runtime copy:

```bash
"/Library/Application Support/Tailscale/BrowserExt/tailscale-browser-ext" -uninstall
```

Then remove the system package payload and receipt:

```bash
sudo rm -f "/Library/Application Support/Tailscale/BrowserExt/tailscale-browser-ext"
sudo rmdir "/Library/Application Support/Tailscale/BrowserExt" 2>/dev/null || true
sudo rm -rf "/Applications/Tailchrome Helper.app"
sudo pkgutil --forget org.tesseras.tailchrome.helper
```

Run the first command once in each macOS user account that used Tailchrome, because native-messaging registrations are per user.

For a per-user app or script install, remove the installed helper and its registrations:

```bash
"$HOME/Library/Application Support/Tailscale/BrowserExt/tailscale-browser-ext" -uninstall
```

You can then move the downloaded app to the Trash.

The script can invoke the same command after validating the requested
release version:

```bash
bash ./tailchrome-install.sh --version vX.Y.Z --uninstall
```
