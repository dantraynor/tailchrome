# macOS Helper installer (.pkg)

The script `build-pkg.sh` produces `dist/tailchrome-helper-macos.pkg`, which installs:

1. **Universal** `tailscale-browser-ext` at  
   `/Library/Application Support/Tailscale/BrowserExt/tailscale-browser-ext`
2. **Tailchrome Helper** in `/Applications` — a repair/re-run fallback app.

The package postinstall script runs `tailscale-browser-ext -install-now` for the logged-in console user, so normal installs do not require opening the app manually.

If browser discovery is later damaged, open
`/Applications/Tailchrome Helper.app`. The signed app launches the installed
system helper with `-install-now` and recreates the current user's supported
native-messaging registrations.

## Unsigned builds

CI and local runs produce an unsigned package. Gatekeeper may require **right-click → Open** the first time, or **System Settings → Privacy & Security**.

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

3. Notarize the **installer .pkg** (not the app alone):

   ```bash
   xcrun notarytool submit dist/tailchrome-helper-macos.pkg \
     --apple-id "$APPLE_ID" \
     --team-id "$APPLE_TEAM_ID" \
     --password "$APPLE_APP_SPECIFIC_PASSWORD" \
     --wait
   xcrun stapler staple dist/tailchrome-helper-macos.pkg
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

Pull-request CI builds an unsigned package, expands it, and asserts that the
repair app and executable launcher are present. The release workflow runs
`build-pkg.sh` on `macos-latest`, signs and notarizes the app and package,
staples the package, and stages the final `.pkg` with the other immutable
release candidates. Publication does not rebuild or replace the cleared
package.

## Per-user fallback

The package and repair app remain the preferred paths. If they cannot be used,
the release also contains a version-pinned `tailchrome-install.sh` fallback.
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

`gh attestation verify` is recommended when GitHub CLI is installed. Without
it, the checksum still detects corruption, but the script and checksum share
the same GitHub Release trust boundary.

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

For a per-user fallback install, use the actual installed helper:

```bash
"$HOME/Library/Application Support/Tailscale/BrowserExt/tailscale-browser-ext" -uninstall
```

The fallback script can invoke the same command after validating the requested
release version:

```bash
bash ./tailchrome-install.sh --version vX.Y.Z --uninstall
```
